import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { acceptsImages, gatewayTrial, subagentKey } from "../src/evaluation/gateway-trial.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { gatewayConnection } from "../src/gateway/connection.js";
import { runCommand } from "../src/lib/process.js";

// How a run's subagent model reaches its harness: as an agent option of SelfBench's Harbor
// adapters, which these tests load with Harbor's own classes stubbed. With the installed Harbor,
// tests/harbor/harbor-subagent-contract.test.ts.

const ADAPTER = fileURLToPath(
  new URL("../src/harnesses/harbor/runtime/harbor_gateway.py", import.meta.url),
);
const subagent = {
  catalogId: "deepseek-v4-pro-0813",
  model: "openrouter/deepseek/deepseek-v4-pro-0813",
  label: "DeepSeek V4 Pro",
  credentialId: "managed-model",
  thinking: "high",
} as const;

/** Harbor's agent modules, stubbed so harbor_gateway.py loads without Harbor installed. */
const STUBS = `import asyncio, importlib.util, json, os, sys, tempfile, types
from pathlib import Path
sys.path.insert(0, os.path.dirname(sys.argv[1]))
class Options:
    append_system_prompt = None
class Agent:
    def __init__(self, **kwargs):
        self.options = types.SimpleNamespace(**{"view_image": True, "subagent_model": None, "subagent_prompt": None, "append_system_prompt": None, **kwargs})
        self.model_name = "openai/dari/model/openai/gpt-6-sol"
        self._base_config = {}
    def build_cli_flags(self):
        return self.options.append_system_prompt or ""
    def _build_effective_config(self, openai_base_url=None):
        return dict(self._base_config)
    async def exec_as_agent(self, environment, command, **kwargs):
        return kwargs.get("env")
    def convert_trajectory(self, logs_dir):
        return "harbor's own choice"
    def _convert_events_to_trajectory(self, session_dir):
        return sorted(path.name for path in Path(session_dir).iterdir())
for name, agent, options in (("claude_code", "ClaudeCode", "ClaudeCodeOptions"), ("codex", "Codex", "CodexOptions"), ("pi", "Pi", "PiOptions")):
    module = types.ModuleType("harbor.agents.installed." + name)
    setattr(module, agent, type(agent, (Agent,), {}))
    setattr(module, options, Options)
    sys.modules[module.__name__] = module
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
MODEL = "dari/model/openrouter/deepseek/deepseek-v4-pro-0813"
`;

async function python(script: string) {
  const result = await runCommand("python3", ["-c", `${STUBS}${script}`, ADAPTER]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
}

test.each(["claude-code", "codex"] as const)(
  "%s is given the subagent model's gateway name, and its key serves it",
  (harness) => {
    const input = { modelName: "anthropic/claude-opus-5-5", subagent } as EvaluationInput;
    const connection = gatewayConnection("https://api.example", "s".repeat(40), {
      orgId: 7,
      model: input.modelName,
      credentialId: "managed-model",
      subagent: subagentKey(subagent),
      tags: {},
    });
    const trial = gatewayTrial(input, harness, input.modelName, {}, connection);
    expect(trial.agentArguments).toContain(`subagent_model=dari/model/${subagent.model}`);
    // The delegation prompt is the adapter's to add, beside any a run condition sets: its own
    // for a run that names none, as runs from before conditions named one were told.
    expect(trial.agentArguments.join(" ")).not.toContain("append_system_prompt");
    expect(trial.agentArguments.join(" ")).not.toContain("subagent_prompt");
    // A condition's prompt goes as JSON, so its lines survive and an empty one stays empty.
    const told = (prompt: string) =>
      gatewayTrial(
        { ...input, subagent: { ...subagent, prompt } },
        harness,
        input.modelName,
        {},
        connection,
      ).agentArguments;
    expect(told("Delegate the tests.\nThen verify.")).toContain(
      'subagent_prompt="Delegate the tests.\\nThen verify."',
    );
    expect(told("")).toContain('subagent_prompt=""');
    expect(trial.agentArguments.join(" ")).not.toContain(connection.key);
    expect(trial.model).toBe(
      `${harness === "codex" ? "openai/" : ""}dari/model/anthropic/claude-opus-5-5`,
    );
  },
);

test("a subagent model's key pins its level, and both models must read images", () => {
  expect(subagentKey(subagent)).toEqual({
    model: subagent.model,
    credentialId: "managed-model",
    thinking: "high",
  });
  const { thinking: _level, ...unpinned } = subagent;
  expect(subagentKey({ ...unpinned, thinking: "default" })).toEqual(subagentKey(unpinned));
  expect(subagentKey(unpinned)).not.toHaveProperty("thinking");
  const opus = { modelName: "anthropic/claude-opus-5-5" } as EvaluationInput;
  expect(acceptsImages(opus)).toBe(true);
  // A subagent model the catalog does not know to read images shares the harness's image tool.
  expect(acceptsImages({ ...opus, subagent })).toBe(false);
});

test("Claude Code's subagents are moved to the subagent model once Harbor built its environment", async () => {
  await python(`
async def check():
    env = {"ANTHROPIC_MODEL": "parent", "CLAUDE_CODE_SUBAGENT_MODEL": "parent"}
    agent = adapter.SelfBenchClaudeCode(subagent_model=MODEL)
    actual = await agent.exec_as_agent(None, "claude", env=env)
    assert actual == {"ANTHROPIC_MODEL": "parent", "CLAUDE_CODE_SUBAGENT_MODEL": MODEL, "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"}, actual
    assert env["CLAUDE_CODE_SUBAGENT_MODEL"] == "parent"  # Harbor's own environment is left alone
    assert await agent.exec_as_agent(None, "claude") is None  # a command with no environment
    plain = adapter.SelfBenchClaudeCode()
    assert (await plain.exec_as_agent(None, "claude", env=env)) == env
    # Told to delegate, after any system prompt a run condition appended, for the command only.
    assert agent.build_cli_flags() == adapter.SUBAGENT_REQUIRED_PROMPT
    agent.options.append_system_prompt = "Run the tests first."
    assert agent.build_cli_flags() == "Run the tests first.\\n\\n" + adapter.SUBAGENT_REQUIRED_PROMPT
    assert agent.options.append_system_prompt == "Run the tests first."
    assert plain.build_cli_flags() == ""
    # A condition's own prompt takes the default's place; an empty one tells it nothing.
    own = adapter.SelfBenchClaudeCode(subagent_model=MODEL, subagent_prompt="Delegate the tests.", append_system_prompt="Run the tests first.")
    assert own.build_cli_flags() == "Run the tests first.\\n\\nDelegate the tests."
    assert adapter.SelfBenchClaudeCode(subagent_model=MODEL, subagent_prompt="").build_cli_flags() == ""
    silent = adapter.SelfBenchClaudeCode(subagent_model=MODEL, subagent_prompt="", append_system_prompt="Run the tests first.")
    assert silent.build_cli_flags() == "Run the tests first."
asyncio.run(check())
`);
});

test("Codex's subagents default to the subagent model and share its limits", async () => {
  await python(`
codex = adapter.GatewayCodex(subagent_model=MODEL)
config = codex._build_effective_config("https://gateway.example/v1")
assert config["agents"] == {"enabled": True, "default_subagent_model": MODEL}, config
assert config["developer_instructions"] == adapter.SUBAGENT_REQUIRED_PROMPT
# GPT-6 Sol alone keeps hosted web search; a subagent model that is not OpenAI's turns it off.
assert config["web_search"] == "disabled"
assert config["model_provider"] == "gateway"
codex._base_config = {"developer_instructions": "Keep existing guidance.", "agents": {"max_depth": 2}}
merged = codex._build_effective_config("https://gateway.example/v1")
assert merged["developer_instructions"] == "Keep existing guidance.\\n\\n" + adapter.SUBAGENT_REQUIRED_PROMPT
assert merged["agents"] == {"max_depth": 2, "enabled": True, "default_subagent_model": MODEL}
assert codex._base_config["developer_instructions"] == "Keep existing guidance."
openai = adapter.GatewayCodex(subagent_model="dari/model/openai/gpt-6-luna")
assert "web_search" not in openai._build_effective_config("https://gateway.example/v1")
plain = adapter.GatewayCodex()
config = plain._build_effective_config("https://gateway.example/v1")
assert "agents" not in config and "developer_instructions" not in config and "web_search" not in config
# A condition's own prompt takes the default's place; an empty one adds no instructions.
own = adapter.GatewayCodex(subagent_model=MODEL, subagent_prompt="Delegate the tests.")
assert own._build_effective_config("https://gateway.example/v1")["developer_instructions"] == "Delegate the tests."
silent = adapter.GatewayCodex(subagent_model=MODEL, subagent_prompt="")
config = silent._build_effective_config("https://gateway.example/v1")
assert "developer_instructions" not in config and config["agents"]["default_subagent_model"] == MODEL
silent._base_config = {"developer_instructions": "Keep existing guidance."}
assert silent._build_effective_config("https://gateway.example/v1")["developer_instructions"] == "Keep existing guidance."
`);
});

test("Codex's transcript is the session it was started with, not a subagent's", async () => {
  await python(`
def rollout(directory, name, source):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(json.dumps({"type": "session_meta", "payload": {"id": name, "source": source}}) + "\\n")
spawned = {"subagent": {"thread_spawn": {"parent_thread_id": "a", "depth": 1}}}
with tempfile.TemporaryDirectory() as logs:
    day = Path(logs) / "sessions/2026/11/11"
    codex = adapter.GatewayCodex(subagent_model=MODEL)
    rollout(day, "rollout-2026-11-11T10-00-00-a.jsonl", "exec")
    # One rollout: Harbor's own choice stands.
    assert adapter.parent_rollout(Path(logs) / "sessions") is None
    assert codex.convert_trajectory(Path(logs)) == "harbor's own choice"
    # Subagents' rollouts sort after the parent's, one on the next day's directory.
    rollout(day, "rollout-2026-11-11T10-05-00-b.jsonl", spawned)
    rollout(Path(logs) / "sessions/2026/11/12", "rollout-2026-11-12T00-01-00-c.jsonl", spawned)
    assert adapter.parent_rollout(Path(logs) / "sessions").name == "rollout-2026-11-11T10-00-00-a.jsonl"
    assert codex.convert_trajectory(Path(logs)) == ["rollout-2026-11-11T10-00-00-a.jsonl"]
    # A run without a subagent model is converted as Harbor converts it.
    assert adapter.GatewayCodex().convert_trajectory(Path(logs)) == "harbor's own choice"
    # Rollouts that do not say where they started leave nothing to tell apart.
    (day / "rollout-2026-11-11T10-00-00-a.jsonl").write_text("not json\\n")
    assert adapter.parent_rollout(Path(logs) / "sessions") is None
`);
});
