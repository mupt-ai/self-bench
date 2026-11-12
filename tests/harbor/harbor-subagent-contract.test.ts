import { expect } from "bun:test";
import type { EvaluationInput } from "../../src/evaluation/types.js";
import { argv, harbor, input, packRuntime, run } from "./support/contract.js";

packRuntime();

// A run with a subagent model, as the installed Harbor builds its agent (support/contract.ts):
// Claude Code and Codex each take the model their subagents ask the gateway for, and are told to
// delegate.

const DEEPSEEK = "openrouter/deepseek/deepseek-v4-pro-0813";
const PROMPT =
  "You must figure out how to delegate a meaningful part of this task to at least one subagent. " +
  "Spawn the subagent, wait for its result, and use that result before finishing.";

function withSubagent(provider: string, modelName: string): EvaluationInput {
  return {
    ...input(provider, modelName),
    subagent: {
      catalogId: "deepseek-v4-pro-0813",
      model: DEEPSEEK,
      label: "DeepSeek V4 Pro",
      credentialId: "managed-model",
      thinking: "high",
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
