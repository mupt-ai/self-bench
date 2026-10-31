import type { Harness } from "./models.js";

/** Native model-override support in the Harbor adapters we run, not general LLM capability. */
export const subagentSupport: Record<Harness, { configurable: boolean; description: string }> = {
  "claude-code": {
    configurable: true,
    description: "Configurable delegation model override.",
  },
  codex: {
    configurable: true,
    description: "Configurable default for delegated agents.",
  },
  pi: {
    configurable: false,
    description: "This adapter has no delegation extension.",
  },
  "mini-swe-agent": {
    configurable: false,
    description: "This adapter has no delegation model setting.",
  },
  "terminus-2": {
    configurable: false,
    description: "Summarization calls are not configurable delegated agents.",
  },
  "muse-code": {
    configurable: false,
    description: "This adapter has no verified delegation model override.",
  },
};
