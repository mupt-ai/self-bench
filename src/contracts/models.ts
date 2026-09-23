/**
 * The one model catalog. Task generation (authoring and verification) and evaluation both read
 * it; each derives its own view — generation its model picker and Pi routes, evaluation its
 * per-credential Harbor routes. Browser-safe: the site imports it too.
 *
 * A model with a `vendor` runs on that vendor's own key under its `id`; every model also runs
 * through OpenRouter as `openRouter`. Rates are reference $/M tokens as of RATES_AS_OF; server
 * processes replace the OpenRouter rates with OpenRouter's live list prices (openrouter-rates.ts).
 */

export const thinkingLevels = [
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

/** [input, output, cache read, cache write] in $ per million tokens. */
export type Rates = readonly [number, number, number, number];

export interface ModelPricing {
  maxInputTokens?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  source: string;
  asOf: string;
}

export interface Model {
  /** The vendor's model id, or a short slug for OpenRouter-only models. */
  readonly id: string;
  readonly label: string;
  readonly vendor?: "openai" | "anthropic";
  readonly openRouter: string;
  readonly source: string;
  readonly rates?: { readonly native?: Rates; readonly openRouter?: Rates };
  /** Selectable reasoning levels, in display order; absent means the provider default only. */
  readonly thinking?: readonly ThinkingLevel[];
  /** Offered for task authoring and verification. */
  readonly generation?: boolean;
}

export const catalogVersion = "2026-09-23.2";
const RATES_AS_OF = "2026-09-23";
const openAiThinking = ["off", "low", "medium", "high", "xhigh", "max"] as const;
const vendorThinking = ["low", "medium", "high", "xhigh", "max"] as const;

export const models: readonly Model[] = [
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    vendor: "openai",
    openRouter: "openai/gpt-6-astra",
    source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
    rates: { native: [10, 50, 1, 12.5], openRouter: [10, 50, 1, 12.5] },
    thinking: vendorThinking,
    generation: true,
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    vendor: "openai",
    openRouter: "openai/gpt-6-sol",
    source: "https://developers.openai.com/api/docs/models/gpt-6-sol",
    rates: { native: [2, 10, 0.2, 2.5], openRouter: [2, 10, 0.2, 2.5] },
    thinking: openAiThinking,
    generation: true,
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    vendor: "openai",
    openRouter: "openai/gpt-6-luna",
    source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
    rates: { native: [0.1, 0.5, 0.01, 0.125], openRouter: [0.1, 0.5, 0.01, 0.125] },
    thinking: openAiThinking,
  },
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    vendor: "anthropic",
    openRouter: "anthropic/claude-fable-5.1",
    source: "https://platform.claude.com/docs/en/models/overview",
    rates: { native: [10, 50, 0.25, 12.5], openRouter: [10, 50, 0.25, 12.5] },
    thinking: vendorThinking,
    generation: true,
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    vendor: "anthropic",
    openRouter: "anthropic/claude-opus-5.5",
    source: "https://platform.claude.com/docs/en/models/overview",
    rates: { native: [4, 20, 0.2, 5], openRouter: [4, 20, 0.2, 5] },
    thinking: vendorThinking,
    generation: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    vendor: "anthropic",
    openRouter: "anthropic/claude-sonnet-5",
    source: "https://platform.claude.com/docs/en/models/overview",
    rates: { native: [2, 10, 0.2, 2.5], openRouter: [2, 10, 0.2, 2.5] },
    thinking: vendorThinking,
  },
  {
    id: "glm-5.3",
    label: "GLM 5.3",
    openRouter: "z-ai/glm-5.3",
    source: "https://openrouter.ai/z-ai/glm-5.3",
    rates: { openRouter: [0.84, 2.64, 0.156, 0.84] },
    thinking: ["low", "high", "max"],
    generation: true,
  },
  {
    id: "kimi-k3",
    label: "Kimi K3",
    openRouter: "moonshotai/kimi-k3",
    source: "https://openrouter.ai/moonshotai/kimi-k3",
    rates: { openRouter: [3, 15, 0.3, 3] },
    generation: true,
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    openRouter: "google/gemini-3.8-flash",
    source: "https://openrouter.ai/google/gemini-3.8-flash",
  },
  {
    id: "deepseek-v4-pro-0813",
    label: "DeepSeek V4 Pro 0813",
    openRouter: "deepseek/deepseek-v4-pro-0813",
    source: "https://openrouter.ai/deepseek/deepseek-v4-pro-0813",
    thinking: ["off", "low", "high", "max"],
  },
];

/** OpenRouter's live list prices by OpenRouter id; empty until a server process loads them. */
let openRouterRates: ReadonlyMap<string, { readonly rates: Rates; readonly asOf: string }> =
  new Map();

export function setOpenRouterRates(rates: typeof openRouterRates): void {
  openRouterRates = rates;
}

export function findModel(id: string): Model | undefined {
  return models.find((model) => model.id === id);
}

/** Reference pricing for running `model` on its vendor's key or through OpenRouter. */
export function modelPricing(model: Model, via: "native" | "openRouter"): ModelPricing | undefined {
  const live = via === "openRouter" ? openRouterRates.get(model.openRouter) : undefined;
  const rates = live?.rates ?? model.rates?.[via];
  if (!rates) return undefined;
  const [input, output, cacheRead, cacheWrite] = rates;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    source:
      via === "openRouter"
        ? `https://openrouter.ai/${model.openRouter}`
        : model.vendor === "anthropic"
          ? "https://platform.claude.com/docs/en/about-claude/pricing"
          : model.source,
    asOf: live?.asOf ?? RATES_AS_OF,
    maxInputTokens: 200_000,
  };
}

/**
 * The variable a model provider's API key travels under, for Pi and every Harbor harness.
 * OpenAI-compatible providers (OpenAI, Codex, custom endpoints) share OPENAI_API_KEY.
 */
export function modelApiKeyVariable(
  provider: string,
): "ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY" | "OPENAI_API_KEY" {
  return provider === "anthropic"
    ? "ANTHROPIC_API_KEY"
    : provider === "openrouter"
      ? "OPENROUTER_API_KEY"
      : "OPENAI_API_KEY";
}
