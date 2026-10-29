import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { gatewayTrial } from "../src/evaluation/gateway-trial.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { gatewayConnection } from "../src/gateway/connection.js";
import { runCommand } from "../src/lib/process.js";

test("Claude Code receives the authorized full subagent ID as an agent kwarg, not a secret", () => {
  const input = {
    modelName: "anthropic/claude-parent",
    subagent: {
      catalogId: "flash",
      model: "openrouter/deepseek/flash-1017",
      credentialId: "managed-model",
    },
  } as EvaluationInput;
  const connection = gatewayConnection("https://api.example", "s".repeat(40), {
    orgId: 7,
    model: input.modelName,
    credentialId: "managed-model",
    ...(input.subagent ? { subagent: input.subagent } : {}),
    tags: {},
  });
  const trial = gatewayTrial(input, "claude-code", input.modelName, {}, connection);
  expect(trial.agentArguments).toContain(
    "subagent_model=dari/model/openrouter/deepseek/flash-1017",
  );
  expect(trial.agentArguments.join(" ")).not.toContain(connection.key);
  expect(trial.model).toBe("dari/model/anthropic/claude-parent");
});

test("the Harbor adapter overrides its subagent pin after env construction and preserves the parent", async () => {
  const result = await runCommand("python3", [
    "-c",
    `
import asyncio, importlib.util, sys, types
class ClaudeCode:
    def __init__(self, **kwargs):
        self.options = type(self).options_model()
        for key, value in kwargs.items():
            setattr(self.options, key, value)
    async def exec_as_agent(self, environment, command, **kwargs):
        return kwargs.get("env")
sys.modules["harbor.agents.installed.claude_code"] = types.SimpleNamespace(ClaudeCode=ClaudeCode, ClaudeCodeOptions=object)
sys.modules["harbor.agents.installed.codex"] = types.SimpleNamespace(Codex=object)
sys.modules["harbor.agents.installed.pi"] = types.SimpleNamespace(Pi=object, PiOptions=object)
sys.modules["harbor.agents.model_connection"] = types.SimpleNamespace(ModelConnectionSpec=lambda **kw: kw)
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
async def check():
    env = {"ANTHROPIC_MODEL": "parent", "CLAUDE_CODE_SUBAGENT_MODEL": "parent"}
    agent = adapter.SelfBenchClaudeCode(subagent_model="dari/model/openrouter/deepseek/flash")
    actual = await agent.exec_as_agent(None, "claude", env=env)
    assert actual["CLAUDE_CODE_SUBAGENT_MODEL"] == "dari/model/openrouter/deepseek/flash"
    assert actual["ANTHROPIC_MODEL"] == "parent"
    assert env["CLAUDE_CODE_SUBAGENT_MODEL"] == "parent"
    plain = adapter.SelfBenchClaudeCode()
    assert (await plain.exec_as_agent(None, "claude", env=env)) == env
asyncio.run(check())
`,
    fileURLToPath(new URL("../src/harnesses/harbor/runtime/harbor_gateway.py", import.meta.url)),
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
});
