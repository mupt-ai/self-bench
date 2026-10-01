import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { credentialSchema } from "../src/db/credentials.js";
import { catalog } from "../src/evaluation/catalog.js";
import { gatewayModel, gatewayTrial, solverAgent } from "../src/evaluation/execution.js";
import { harnessIds, modelRoutes, routeFor } from "../src/evaluation/models.js";
import { solverArguments } from "../src/evaluation/runner.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { gatewayIds, gateways, isGateway } from "../src/gateways/index.js";
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
    // The provider picks the adapter, so a typed id with no vendor still gets HTTPS-only Codex.
    expect(gatewayTrial(input, "codex", `${provider}/gpt-4o`, env).model).toBe("openai/gpt-4o");
    expect(solverAgent("codex", provider)).toBe("harbor_gateway:GatewayCodex");
    for (const harness of ["mini-swe-agent", "terminus-2"] as const) {
      const result = gatewayTrial(input, harness, name, env);
      expect(result.model).toBe(codex.model);
      expect(result.child.OPENAI_API_BASE).toBe(codex.child.OPENAI_BASE_URL);
    }
    const pi = gatewayTrial(input, "pi", name, env);
    expect(pi.model).toBe(name);
    expect(Object.keys(pi.child).filter((key) => key.endsWith("_API_KEY"))).toEqual([keyVariable]);
    // Harbor's own Pi adapter does not pass Vercel's key to Pi.
    expect(solverAgent("pi", provider)).toBe(
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

test("only gateway routes offer every harness; direct keys keep their native harnesses", () => {
  for (const entry of catalog) {
    for (const route of modelRoutes(entry)) {
      if (isGateway(route.provider)) expect(new Set(route.harnesses)).toEqual(new Set(harnessIds));
      else
        expect(route.harnesses).not.toContain(
          route.provider === "openai" ? "claude-code" : "codex",
        );
    }
  }
  const model = catalog.find((entry) => entry.id === "gpt-6-sol");
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
