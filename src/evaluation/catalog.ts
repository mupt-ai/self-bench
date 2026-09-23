import type { Harness } from "./models.js";
import type { EvaluationPricing } from "./types.js";

export const catalogVersion = "2026-09-14.1";
const supportedProviders = ["openai", "anthropic", "openrouter", "custom"] as const;
type CatalogProvider = (typeof supportedProviders)[number];
export interface CatalogModel {
  id: string;
  provider: CatalogProvider;
  model: string;
  label: string;
  harnesses: Harness[];
  source: string;
  pricing?: EvaluationPricing;
}
export const catalog: CatalogModel[] = [
  {
    id: "openai-astra6",
    provider: "openai",
    model: "gpt-6-astra",
    label: "GPT-6 Astra",
    harnesses: ["codex", "pi"],
    source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
  },
  {
    id: "openai-sol56",
    provider: "openai",
    model: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    harnesses: ["codex", "pi"],
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
  {
    id: "openai-terra56",
    provider: "openai",
    model: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    harnesses: ["codex", "pi"],
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  },
  {
    id: "openai-luna56",
    provider: "openai",
    model: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    harnesses: ["codex", "pi"],
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  },
  {
    id: "anthropic-fable51",
    provider: "anthropic",
    model: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    harnesses: ["claude-code", "pi"],
    source: "https://platform.claude.com/docs/en/models/overview",
  },
  {
    id: "anthropic-opus5",
    provider: "anthropic",
    model: "claude-opus-5",
    label: "Claude Opus 5",
    harnesses: ["claude-code", "pi"],
    source: "https://platform.claude.com/docs/en/models/overview",
  },
  {
    id: "anthropic-sonnet5",
    provider: "anthropic",
    model: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    harnesses: ["claude-code", "pi"],
    source: "https://platform.claude.com/docs/en/models/overview",
  },
  {
    id: "router-gemini38",
    provider: "openrouter",
    model: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    harnesses: ["pi"],
    source: "https://openrouter.ai/google/gemini-3.8-flash",
  },
  {
    id: "router-glm53",
    provider: "openrouter",
    model: "z-ai/glm-5.3",
    label: "GLM-5.3",
    harnesses: ["pi"],
    source: "https://openrouter.ai/z-ai/glm-5.3",
  },
  {
    id: "router-kimi3",
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    label: "Kimi K3",
    harnesses: ["pi"],
    source: "https://openrouter.ai/moonshotai/kimi-k3",
  },
  {
    id: "router-deepseek4",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    harnesses: ["pi"],
    source: "https://openrouter.ai/deepseek/deepseek-v4-pro",
  },
  {
    id: "router-glm53flash",
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    harnesses: ["pi"],
    source: "https://openrouter.ai/z-ai/glm-5.3-flash",
  },
  {
    id: "router-deepseek41flash",
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    harnesses: ["pi"],
    source: "https://openrouter.ai/deepseek/deepseek-v4.1-flash",
  },
  {
    id: "router-deepseek4flash0731",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731",
    harnesses: ["pi"],
    source: "https://openrouter.ai/deepseek/deepseek-v4-flash-0731",
  },
  {
    id: "router-minimax3",
    provider: "openrouter",
    model: "minimax/minimax-m3",
    label: "MiniMax M3",
    harnesses: ["pi"],
    source: "https://openrouter.ai/minimax/minimax-m3",
  },
];
export const hostedSandboxes = ["e2b", "modal", "daytona"] as const;
export type HostedSandbox = (typeof hostedSandboxes)[number];

const rates: Record<string, [number, number, number, number]> = {
  "openai-astra6": [10, 50, 1, 12.5],
  "openai-sol56": [4, 20, 0.4, 5],
  "openai-terra56": [2, 12, 0.2, 2.5],
  "openai-luna56": [0.2, 1.2, 0.02, 0.25],
  "anthropic-fable51": [10, 50, 0.25, 12.5],
  "anthropic-opus5": [5, 25, 0.5, 6.25],
  "anthropic-sonnet5": [2, 10, 0.2, 2.5],
  "router-astra6": [10, 50, 1, 12.5],
  "router-sol56": [2, 10, 0.2, 2.5],
  "router-terra56": [2, 12, 0.2, 2.5],
  "router-luna56": [0.2, 1.2, 0.02, 0.25],
  "router-opus5": [5, 25, 0.5, 6.25],
  "router-fable51": [10, 50, 0.25, 12.5],
  "router-sonnet5": [2, 10, 0.2, 2.5],
  "router-glm53": [0.896, 2.816, 0.1664, 0.896],
  "router-kimi3": [1.7, 8.5, 0.17, 1.7],
};

/** Reference pricing for a rate-table id (e.g. "router-sol56"), independent of the catalog. */
export function referencePricing(id: string): EvaluationPricing | undefined {
  const rate = rates[id];
  if (!rate) return undefined;
  const [input, output, cacheRead, cacheWrite] = rate;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    source: id.startsWith("anthropic-")
      ? "https://platform.claude.com/docs/en/about-claude/pricing"
      : "https://openrouter.ai",
    asOf: "2026-09-06",
    maxInputTokens: 200_000,
  };
}

export function withReferencePricing(model: CatalogModel): CatalogModel {
  const rate = rates[model.id];
  if (!rate) return model;
  const [input, output, cacheRead, cacheWrite] = rate;
  return {
    ...model,
    pricing: {
      input,
      output,
      cacheRead,
      cacheWrite,
      source:
        model.provider === "anthropic"
          ? "https://platform.claude.com/docs/en/about-claude/pricing"
          : model.source,
      asOf: "2026-09-06",
      maxInputTokens: 200_000,
    },
  };
}
