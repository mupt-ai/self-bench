import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { credentialSchema } from "../src/db/credentials.js";
import { catalog, evaluationCatalog } from "../src/evaluation/catalog.js";
import { gatewayModel, gatewayTrial } from "../src/evaluation/execution.js";
import { harnessIds, modelRoutes, routeFor } from "../src/evaluation/models.js";
import { solverArguments } from "../src/evaluation/runner.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { gatewayIds, gateways, isGateway, setGatewayListing } from "../src/gateways/index.js";
import { PI_VERSION } from "../src/harnesses/pi/version.js";
import { runCommand } from "../src/lib/process.js";

test("native Codex uses an isolated installer without inheriting the image's NVM directory", async () => {
  expect(solverArguments("task", "jobs", "codex", "openai/gpt-6-sol", "modal")).toContain(
    "harbor_gateway:SelfBenchCodex",
  );
  const result = await runCommand("python3", [
    "-c",
    `import asyncio, importlib.util, os, subprocess, sys, types
module = types.ModuleType("harbor.agents.installed.codex")
class Codex:
    def _build_effective_config(self, openai_base_url=None):
        return {"openai_base_url": openai_base_url} if openai_base_url else {}
    async def exec_as_agent(self, environment, command, **kwargs):
        return command, kwargs
module.Codex = Codex
sys.modules[module.__name__] = module
pi = types.ModuleType("harbor.agents.installed.pi")
pi.Pi = type("Pi", (), {})
sys.modules[pi.__name__] = pi
connection = types.ModuleType("harbor.agents.model_connection")
connection.ModelConnectionSpec = lambda **kwargs: kwargs
sys.modules[connection.__name__] = connection
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
async def check():
    command, options = await adapter.SelfBenchCodex().exec_as_agent(None, 'printf %s "$NVM_DIR"', timeout_sec=30)
    output = subprocess.check_output(["bash", "-c", command], env={**os.environ, "HOME": "/root", "NVM_DIR": "/usr/local/share/nvm"}, text=True)
    assert output == "/root/.nvm"
    assert options == {"timeout_sec": 30}
    gateway = adapter.GatewayCodex()
    gateway.model_name = "openai/anthropic/claude-sonnet-5"
    command, _ = await gateway.exec_as_agent(None, "codex exec --model claude-sonnet-5 --json")
    assert "--model anthropic/claude-sonnet-5 " in command
    assert command.startswith('export NVM_DIR="$HOME/.nvm"; ')
    # Vercel AI Gateway takes Codex's WebSocket upgrade and then fails the turn; gateways get HTTPS.
    config = gateway._build_effective_config("https://gateway.example/v1")
    assert "openai_base_url" not in config
    assert config["model_providers"][config["model_provider"]] == {
        "name": "Gateway", "base_url": "https://gateway.example/v1", "env_key": "OPENAI_API_KEY",
        "wire_api": "responses", "supports_websockets": False}
asyncio.run(check())
`,
    fileURLToPath(new URL("../src/harnesses/harbor/runtime/harbor_gateway.py", import.meta.url)),
  ]);
  expect(result.exitCode).toBe(0);
});

test("Pi with ChatGPT sign-in uses its OAuth model and pinned installer", () => {
  const input = { credentials: { provider: "openai", auth: "codex-login" } } as EvaluationInput;
  const trial = gatewayTrial(input, "pi", "openai/gpt-6.1-sol", {});
  expect(trial.model).toBe("openai-codex/gpt-6.1-sol");
  expect(trial.extraAllowedHosts).toContain("chatgpt.com");
  expect(trial.child.OPENAI_API_KEY).toBeUndefined();
  const args = solverArguments("task", "jobs", "pi", trial.model, "e2b", "high");
  expect(args).toContain("harbor_pi:SelfBenchPi");
  expect(args).toContain(`version=${PI_VERSION}`);
  expect(args).toContain("thinking=high");
});

test("Harbor Pi places only the selected subscription in the sandbox before invocation", async () => {
  const result = await runCommand("python3", [
    "-c",
    `import asyncio, importlib.util, pathlib, sys, types
module = types.ModuleType("harbor.agents.installed.pi")
class Pi:
    def _get_env(self, key):
        assert key == "SELFBENCH_PI_AUTH_JSON_PATH"
        return "/worker/trial-auth.json"
    async def exec_as_agent(self, environment, command, **kwargs):
        environment.calls.append(("agent", command, kwargs))
        return "result"
    async def exec_as_root(self, environment, command):
        environment.calls.append(("root", command))
module.Pi = Pi
sys.modules[module.__name__] = module
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
class Environment:
    default_user = "agent"
    def __init__(self): self.calls = []
    async def upload_file(self, source, target):
        assert source == pathlib.Path("/worker/trial-auth.json")
        self.calls.append(("upload", target))
async def check():
    env = Environment()
    agent = adapter.SelfBenchPi()
    await agent.exec_as_agent(env, "pi --version")
    assert len(env.calls) == 1 and env.calls[0][0] == "agent"
    await agent.exec_as_agent(env, ". ~/.nvm/nvm.sh; pi --print --provider openai-codex --model gpt-6.1-sol", timeout_sec=30)
    assert [call[0] for call in env.calls[1:]] == ["upload", "root", "agent", "agent"]
    assert env.calls[1][1] == "/tmp/harbor-pi-auth.json"
    assert "chown agent" in env.calls[2][1] and "chmod 600" in env.calls[2][1]
    assert 'install -m 600 /tmp/harbor-pi-auth.json "$HOME/.pi/agent/auth.json"' in env.calls[3][1]
    assert "rm /tmp/harbor-pi-auth.json" in env.calls[3][1]
    assert env.calls[4][2] == {"timeout_sec": 30}
asyncio.run(check())
`,
    fileURLToPath(new URL("../src/harnesses/harbor/runtime/harbor_pi.py", import.meta.url)),
  ]);
  expect(result.exitCode).toBe(0);
});

for (const provider of gatewayIds) {
  test(`${provider} uses each harness protocol and preserves gateway model IDs`, () => {
    const input = { credentials: { provider } } as EvaluationInput;
    const { keyVariable, hosts } = gateways[provider];
    // The other gateway's key never reaches a trial.
    const env = { OPENROUTER_API_KEY: "test-key", AI_GATEWAY_API_KEY: "test-key" };
    const original = { ...env };
    const name = `${provider}/anthropic/claude-sonnet-5`;
    const claude = gatewayTrial(input, "claude-code", name, env);
    expect(claude.model).toBe("anthropic/claude-sonnet-5");
    expect(claude.child.ANTHROPIC_API_KEY).toBe("test-key");
    expect(claude.child.OPENAI_API_KEY).toBeUndefined();
    const codex = gatewayTrial(input, "codex", name, env);
    expect(codex.model).toBe("openai/anthropic/claude-sonnet-5");
    expect(codex.child.OPENAI_API_KEY).toBe("test-key");
    expect(codex.child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codex.child.OPENAI_BASE_URL).toBe(gateways[provider].openAiBase);
    expect(codex.extraAllowedHosts).toEqual([...hosts]);
    expect(solverArguments("task", "jobs", "codex", codex.model, "e2b")).toContain(
      "harbor_gateway:GatewayCodex",
    );
    for (const harness of ["mini-swe-agent", "terminus-2"] as const) {
      const result = gatewayTrial(input, harness, name, env);
      expect(result.model).toBe(codex.model);
      expect(result.child.OPENAI_API_BASE).toBe(codex.child.OPENAI_BASE_URL);
    }
    const pi = gatewayTrial(input, "pi", name, env);
    expect(pi.model).toBe(name);
    expect(Object.keys(pi.child).filter((key) => key.endsWith("_API_KEY"))).toEqual([keyVariable]);
    // Harbor's own Pi adapter does not pass Vercel's key to Pi.
    expect(solverArguments("task", "jobs", "pi", pi.model, "e2b")).toContain(
      provider === "vercel-ai-gateway" ? "harbor_gateway:GatewayPi" : "pi",
    );
    expect(env).toEqual(original);
    // Cost verification derives the same Harbor model name the runner passes.
    for (const harness of harnessIds)
      expect(gatewayModel(provider, harness, name)).toBe(
        gatewayTrial(input, harness, name, env).model,
      );
    expect(() => gatewayTrial(input, "codex", name, {})).toThrow("Gateway credential");
  });
}

test("only listed gateway routes offer every harness; direct keys keep native harnesses", () => {
  const listed = { models: [{ id: "openai/gpt-6-sol", label: "GPT-6 Sol" }], rates: new Map() };
  for (const gateway of gatewayIds) setGatewayListing(gateway, listed);
  for (const entry of catalog) {
    for (const route of modelRoutes(entry)) {
      if (isGateway(route.provider)) expect(new Set(route.harnesses)).toEqual(new Set(harnessIds));
      else
        expect(route.harnesses).not.toContain(
          route.provider === "openai" ? "claude-code" : "codex",
        );
    }
  }
  const model = evaluationCatalog().find((entry) => entry.id === "gpt-6-sol");
  if (!model) throw new Error("Missing model fixture");
  expect(routeFor(model, "openrouter")?.harnesses).toContain("claude-code");
  expect(routeFor(model, "openrouter")?.harnesses).toContain("mini-swe-agent");
  expect(routeFor(model, "vercel-ai-gateway")?.harnesses).toContain("claude-code");
  expect(routeFor(model, "openai")?.harnesses).not.toContain("claude-code");
  const anthropic = catalog.find((entry) => entry.id === "claude-opus-5-5");
  if (!anthropic) throw new Error("Missing model fixture");
  expect(routeFor(anthropic, "anthropic")?.harnesses).not.toContain("codex");
  expect(routeFor(model, "vercel")).toBeUndefined();
  expect(
    credentialSchema.parse({ name: "Gateway", kind: "openrouter", value: "test-key" }).kind,
  ).toBe("openrouter");
  expect(() =>
    credentialSchema.parse({
      name: "Gateway",
      kind: "openrouter",
      value: "test-key",
      endpoint: "https://wrong.example",
    }),
  ).toThrow();
});
