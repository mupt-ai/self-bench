import { expect } from "bun:test";
import type { EvaluationInput } from "../../src/evaluation/types.js";
import { runCommand } from "../../src/lib/process.js";
import { argv, harbor, input, packRuntime, python, run, runtime } from "./support/contract.js";

packRuntime();

// A run with a subagent model, as the installed Harbor builds its agent (support/contract.ts):
// Claude Code and Codex each take the model their subagents ask the gateway for, and are told to
// delegate.

const DEEPSEEK = "openrouter/deepseek/deepseek-v4-pro-0813";
const PROMPT =
  "You must figure out how to delegate a meaningful part of this task to at least one subagent. " +
  "Spawn the subagent, wait for its result, and use that result before finishing.";

/** A run with a subagent model, told `prompt` when its condition gave one. */
function withSubagent(provider: string, modelName: string, prompt?: string): EvaluationInput {
  return {
    ...input(provider, modelName),
    subagent: {
      catalogId: "deepseek-v4-pro-0813",
      model: DEEPSEEK,
      label: "DeepSeek V4 Pro",
      credentialId: "managed-model",
      thinking: "high",
      ...(prompt === undefined ? {} : { prompt }),
    },
  };
}

harbor("Claude Code's subagents ask the gateway for the subagent model", async () => {
  const { start, key } = await run(
    withSubagent("anthropic", "anthropic/claude-opus-5-5"),
    "claude-code",
  );
  const claude = start("claude --verbose");
  // Harbor points every tier and the subagents at the run's model; only the subagents' moves,
  // and FORCE keeps it over any model a subagent's definition or the Agent tool names.
  expect(claude.env).toMatchObject({
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: "https://api.selfbench.test/gateway",
    ANTHROPIC_MODEL: "dari/model/anthropic/claude-opus-5-5",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "dari/model/anthropic/claude-opus-5-5",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "dari/model/anthropic/claude-opus-5-5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "dari/model/anthropic/claude-opus-5-5",
    CLAUDE_CODE_SUBAGENT_MODEL: `dari/model/${DEEPSEEK}`,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
  });
  const args = argv(claude.command, "claude");
  expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(PROMPT);
  expect(args[args.indexOf("--effort") + 1]).toBe("high");
});

harbor("Claude Code is told to delegate after a condition's own system prompt", async () => {
  const { start } = await run(
    withSubagent("anthropic", "anthropic/claude-opus-5-5"),
    "claude-code",
    {},
    {
      name: "Tests First",
      harnessOptions: { "claude-code": { append_system_prompt: "Run the tests first." } },
    },
  );
  const args = argv(start("claude --verbose").command, "claude");
  expect(args.filter((argument) => argument === "--append-system-prompt")).toHaveLength(1);
  expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
    `Run the tests first.\n\n${PROMPT}`,
  );
});

harbor(
  "each harness is told its condition's delegation prompt, or nothing when it is empty",
  async () => {
    const own = "Hand the tests to a subagent.\nCheck its work before finishing.";
    const claude = async (prompt: string) =>
      argv(
        (
          await run(withSubagent("anthropic", "anthropic/claude-opus-5-5", prompt), "claude-code")
        ).start("claude --verbose").command,
        "claude",
      );
    const told = await claude(own);
    expect(told[told.indexOf("--append-system-prompt") + 1]).toBe(own);
    expect(await claude("")).not.toContain("--append-system-prompt");
    const codex = async (prompt: string) =>
      (await run(withSubagent("openai", "openai/gpt-6-sol", prompt), "codex")).recorded.files[
        "/installed-agent/codex-home/config.toml"
      ] ?? "";
    expect(await codex(own)).toContain(`developer_instructions = ${JSON.stringify(own)}`);
    const silent = await codex("");
    expect(silent).not.toContain("developer_instructions");
    // Its subagents still run on the subagent model.
    expect(silent).toContain(`default_subagent_model = "dari/model/${DEEPSEEK}"`);
  },
);

harbor("Claude Code without a subagent model keeps its subagents on the run's model", async () => {
  const { start } = await run(input("anthropic", "anthropic/claude-opus-5-5"), "claude-code");
  const claude = start("claude --verbose");
  expect(claude.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("dari/model/anthropic/claude-opus-5-5");
  expect(claude.env).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL_FORCE");
  expect(claude.command).not.toContain("--append-system-prompt");
});

harbor("Codex's subagents default to the subagent model on the gateway", async () => {
  const { recorded, start } = await run(withSubagent("openai", "openai/gpt-6-sol"), "codex");
  const args = argv(start("codex exec").command, "codex");
  expect(args[args.indexOf("--model") + 1]).toBe("dari/model/openai/gpt-6-sol");
  const config = recorded.files["/installed-agent/codex-home/config.toml"] ?? "";
  expect(config).toMatch(
    new RegExp(
      `\\[agents\\]\\s*\\nenabled = true\\s*\\ndefault_subagent_model = "dari/model/${DEEPSEEK}"`,
    ),
  );
  expect(config).toContain(`developer_instructions = "${PROMPT}"`);
  expect(config).toContain('model_provider = "gateway"');
  // Subagents share Codex's tools: DeepSeek takes no hosted web search, so neither model is
  // offered it, though GPT-6 Sol alone would be.
  expect(config).toContain('web_search = "disabled"');
});

harbor("Codex without a subagent model sets none", async () => {
  const { recorded } = await run(input("openai", "openai/gpt-6-sol"), "codex");
  const config = recorded.files["/installed-agent/codex-home/config.toml"] ?? "";
  expect(config).not.toContain("[agents]");
  expect(config).not.toContain("developer_instructions");
  expect(config).not.toContain("web_search");
});

harbor(
  "Codex's trajectory is the session it was started with, not its last subagent's",
  async () => {
    // Codex writes each subagent's rollout beside the parent's, and Harbor converts the one that
    // sorts last. Harbor's converter takes the directory of rollouts, so the parent's is converted
    // from a directory holding it alone.
    const script = `import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from harbor_gateway import GatewayCodex
def rollout(day, name, source, said):
    day.mkdir(parents=True, exist_ok=True)
    usage = {"input_tokens": 10, "cached_input_tokens": 0, "output_tokens": 2, "total_tokens": 12}
    lines = [
        {"type": "session_meta", "payload": {"id": name, "source": source, "cli_version": "0.167.1"}},
        {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "task"}]}},
        {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": said}]}},
        {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": usage, "last_token_usage": usage}}},
    ]
    (day / name).write_text("".join(json.dumps({"timestamp": "2026-11-11T10:00:00Z", **line}) + "\\n" for line in lines))
def said(agent, logs):
    return [step.message for step in agent.convert_trajectory(Path(logs)).steps if step.source == "agent"]
model = "openai/dari/model/openai/gpt-6-sol"
with tempfile.TemporaryDirectory() as logs:
    day = Path(logs) / "sessions/2026/11/11"
    rollout(day, "rollout-2026-11-11T10-00-00-parent.jsonl", "exec", "orchestrator")
    rollout(day, "rollout-2026-11-11T10-05-00-child.jsonl", {"subagent": {"thread_spawn": {"parent_thread_id": "p", "depth": 1}}}, "subagent")
    mixed = GatewayCodex(logs_dir=Path(logs), model_name=model, subagent_model="dari/model/openrouter/deepseek/deepseek-v4-pro-0813")
    assert said(mixed, logs) == ["orchestrator"], said(mixed, logs)
    # Harbor's own choice, which a run without a subagent model keeps: the last rollout.
    assert said(GatewayCodex(logs_dir=Path(logs), model_name=model), logs) == ["subagent"]
print("ok")
`;
    const result = await runCommand(python ?? "python3", ["-c", script, runtime]);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("ok");
  },
);
