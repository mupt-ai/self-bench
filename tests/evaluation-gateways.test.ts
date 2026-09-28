import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { credentialSchema } from "../src/db/credentials.js";
import { catalog } from "../src/evaluation/catalog.js";
import { gatewayModel, gatewayTrial } from "../src/evaluation/execution.js";
import { harnessIds, harnessVersions, modelRoutes, routeFor } from "../src/evaluation/models.js";
import { solverArguments } from "../src/evaluation/runner.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { runCommand } from "../src/lib/process.js";

const adapterPath = fileURLToPath(
  new URL("../src/harnesses/harbor/runtime/harbor_gateway.py", import.meta.url),
);

/** Loads harbor_gateway.py over stand-ins for Harbor's installed agents, then runs `check`. */
async function checkAdapters(check: string) {
  const result = await runCommand("python3", [
    "-c",
    `import asyncio, importlib.util, os, subprocess, sys, types
from types import SimpleNamespace
class Installed:
    _version = None
    def __init__(self):
        self.calls = []
    async def exec_as_agent(self, environment, command, **kwargs):
        return command, kwargs
    async def exec_as_root(self, environment, command, **kwargs):
        self.calls.append(("root", command))
    async def ensure_system_dependencies(self, environment, dependencies):
        self.calls.append(("apt", dependencies))
    async def install(self, environment):
        await self.ensure_system_dependencies(environment, ("curl",))
        self.calls.append(("harbor-install", self._version))
    async def _installed_codex_satisfies_version(self, environment):
        return False
    async def _installed_claude_satisfies_version(self, environment):
        return False
    def parse_version(self, stdout):
        return stdout.strip()
    def _package_name(self):
        return "@earendil-works/pi-coding-agent"
for name, cls in [("codex", "Codex"), ("claude_code", "ClaudeCode"), ("pi", "Pi")]:
    module = types.ModuleType(f"harbor.agents.installed.{name}")
    setattr(module, cls, type(cls, (Installed,), {}))
    sys.modules[module.__name__] = module
class Environment:
    def __init__(self, runtime):
        self.runtime = runtime
    async def exec(self, command, **kwargs):
        prebaked = command.startswith("test -x /opt/selfbench-agent-runtime/")
        return SimpleNamespace(return_code=0 if prebaked and self.runtime else 1, stdout="")
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
${check}
`,
    adapterPath,
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
}

test("native Codex uses an isolated installer without inheriting the image's NVM directory", async () => {
  expect(solverArguments("task", "jobs", "codex", "openai/gpt-6-sol", "modal")).toContain(
    "harbor_gateway:SelfBenchCodex",
  );
  await checkAdapters(`async def check():
    command, options = await adapter.SelfBenchCodex().exec_as_agent(None, 'printf %s "$NVM_DIR"', timeout_sec=30)
    output = subprocess.check_output(["bash", "-c", command], env={**os.environ, "HOME": "/home/test-agent", "NVM_DIR": "/usr/local/share/nvm"}, text=True)
    assert output == "/home/test-agent/.nvm"
    assert options == {"timeout_sec": 30}
    gateway = adapter.GatewayCodex()
    gateway.model_name = "openai/anthropic/claude-sonnet-5"
    command, _ = await gateway.exec_as_agent(None, "codex exec --model claude-sonnet-5 --json")
    assert "--model anthropic/claude-sonnet-5 " in command
    assert command.startswith('export NVM_DIR="$HOME/.nvm"; ')
asyncio.run(check())`);
});

test("trials pin each Node harness CLI and install it onto a prebaked runtime without apt", async () => {
  for (const [harness, agent, version] of [
    ["codex", "harbor_gateway:SelfBenchCodex", harnessVersions.codex],
    ["claude-code", "harbor_gateway:SelfBenchClaudeCode", harnessVersions["claude-code"]],
    ["pi", "harbor_gateway:SelfBenchPi", harnessVersions.pi],
  ] as const) {
    const args = solverArguments("task", "jobs", harness, "openai/gpt-6-sol", "modal");
    expect(args[args.indexOf("--agent") + 1]).toBe(agent);
    expect(args).toContain(`version=${version}`);
  }
  const args = solverArguments("task", "jobs", "terminus-2", "openai/gpt-6-sol", "modal");
  expect(args.some((arg) => arg.startsWith("version="))).toBe(false);
  await checkAdapters(`async def check():
    for cls, package, command in [
        (adapter.SelfBenchCodex, "@openai/codex", "codex"),
        (adapter.SelfBenchClaudeCode, "@anthropic-ai/claude-code", "claude"),
        (adapter.SelfBenchPi, "@earendil-works/pi-coding-agent", "pi"),
    ]:
        agent = cls()
        agent._version = "1.2.3"
        await agent.install(Environment(runtime=True))
        assert len(agent.calls) == 1 and agent.calls[0][0] == "root", agent.calls
        script = agent.calls[0][1]
        assert f"{package}@1.2.3" in script and f"/usr/local/bin/{command}" in script, script
        # Tasks compiled before the runtime existed keep Harbor's own install.
        legacy = cls()
        legacy._version = "1.2.3"
        await legacy.install(Environment(runtime=False))
        assert legacy.calls == [("apt", ("curl",)), ("harbor-install", "1.2.3")], legacy.calls
    command, _ = await adapter.SelfBenchPi().exec_as_agent(None, ". ~/.nvm/nvm.sh; pi --print")
    assert command == "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; pi --print", command
asyncio.run(check())`);
});

for (const provider of ["openrouter"] as const) {
  test(`${provider} uses each harness protocol and preserves gateway model IDs`, () => {
    const input = { credentials: { provider } } as EvaluationInput;
    const env = {
      OPENROUTER_API_KEY: "test-key",
    };
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
    expect(codex.child.OPENAI_BASE_URL).toContain("openrouter.ai/api/v1");
    expect(solverArguments("task", "jobs", "codex", codex.model, "e2b")).toContain(
      "harbor_gateway:GatewayCodex",
    );
    for (const harness of ["mini-swe-agent", "terminus-2"] as const) {
      const result = gatewayTrial(input, harness, name, env);
      expect(result.model).toBe(codex.model);
      expect(result.child.OPENAI_API_BASE).toBe(codex.child.OPENAI_BASE_URL);
    }
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
      if (route.provider === "openrouter")
        expect(new Set(route.harnesses)).toEqual(new Set(harnessIds));
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
