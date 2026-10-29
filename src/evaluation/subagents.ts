import type { Harness } from "./models.js";

/** Native model-override support in the Harbor adapters we run, not general LLM capability. */
export const subagentSupport: Record<Harness, { configurable: boolean; description: string }> = {
  "claude-code": {
    configurable: true,
    description: "Overrides Claude Code's subagent model when it delegates.",
  },
  codex: {
    configurable: true,
    description:
      "Sets Codex's default subagent model. Explicit spawn options and custom agents may override this default; only authorized models can be called.",
  },
  pi: {
    configurable: false,
    description:
      "This Harbor Pi adapter does not install a subagent extension. A model setting alone cannot enable delegation.",
  },
  "mini-swe-agent": {
    configurable: false,
    description: "Mini-SWE-Agent's Harbor adapter has no delegated-agent model setting.",
  },
  "terminus-2": {
    configurable: false,
    description:
      "Terminus 2's internal context-summarization calls are not configurable task-delegation agents in this integration.",
  },
  "muse-code": {
    configurable: false,
    description:
      "Muse Code delegates internally, but this adapter has no verified independent subagent-model override or gateway route.",
  },
};
