import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { credentialSchema } from "../src/db/credentials.js";
import { catalog } from "../src/evaluation/catalog.js";
import { gatewayTrial } from "../src/evaluation/execution.js";
import { harnessIds, modelRoutes, routeFor } from "../src/evaluation/models.js";
import { solverArguments } from "../src/evaluation/runner.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { runCommand } from "../src/lib/process.js";

test("native Codex uses an isolated installer without inheriting the image's NVM directory", async () => {
  expect(solverArguments("task", "jobs", "codex", "openai/gpt-5.6-sol", "modal")).toContain(
    "harbor_gateway:SelfBenchCodex",
  );
  const result = await runCommand("python3", [
    "-c",
    `import asyncio, importlib.util, os, subprocess, sys, types
module = types.ModuleType("harbor.agents.installed.codex")
class Codex:
    async def exec_as_agent(self, environment, command, **kwargs):
        return command, kwargs
module.Codex = Codex
sys.modules[module.__name__] = module
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
async def check():
    command, options = await adapter.SelfBenchCodex().exec_as_agent(None, 'printf %s "$NVM_DIR"', timeout_sec=30)
    output = subprocess.check_output(["bash", "-c", command], env={**os.environ, "HOME": "/home/test-agent", "NVM_DIR": "/usr/local/share/nvm"}, text=True)
    assert output == "/home/test-agent/.nvm"
    assert options == {"timeout_sec": 30}
    gateway = adapter.GatewayCodex()
    gateway.model_name = "openai/anthropic/claude-sonnet-5"
    command, _ = await gateway.exec_as_agent(None, "codex exec --model claude-sonnet-5 --json")
    assert "--model anthropic/claude-sonnet-5 " in command
    assert command.startswith('export NVM_DIR="$HOME/.nvm"; ')
asyncio.run(check())
`,
    fileURLToPath(new URL("../src/harnesses/harbor/runtime/harbor_gateway.py", import.meta.url)),
  ]);
  expect(result.exitCode).toBe(0);
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
  const model = catalog.find((entry) => entry.id === "openai-sol56");
  if (!model) throw new Error("Missing model fixture");
  expect(routeFor(model, "openrouter")?.harnesses).toContain("claude-code");
  expect(routeFor(model, "openrouter")?.harnesses).toContain("mini-swe-agent");
  expect(routeFor(model, "openai")?.harnesses).not.toContain("claude-code");
  const anthropic = catalog.find((entry) => entry.id === "anthropic-opus5");
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
