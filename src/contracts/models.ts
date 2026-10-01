/**
 * The one model catalog. Task generation (authoring and verification) and evaluation both read
 * it; each derives its own view — generation its model picker and Pi routes, evaluation its
 * per-credential Harbor routes. Browser-safe: the site imports it too.
 *
 * A model with a `vendor` runs on that vendor's own key under its `id`; every model also runs
 * through each gateway (src/gateways), under the id OpenRouter gives it, `openRouter`, respelled
 * for the gateway. Rates are reference $/M tokens as of RATES_AS_OF; server processes replace the
 * gateway rates with each gateway's live list prices, and evaluation adds every other model the
 * gateways list.
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

/** A model id as a provider or gateway spells it, or as someone types one in. */
export const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

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
  /** The vendor's model id, or a short slug for gateway-only models. */
  readonly id: string;
  readonly label: string;
  readonly vendor?: "openai" | "anthropic";
  /** OpenRouter's id, which names the model on every gateway. */
  readonly openRouter: string;
  readonly source: string;
  /** Reference rates on the vendor's own key and through a gateway. */
  readonly rates?: { readonly native?: Rates; readonly gateway?: Rates };
  /** Selectable reasoning levels, in display order; absent means the provider default only. */
  readonly thinking?: readonly ThinkingLevel[];
  /** Offered for task authoring and verification. */
  readonly generation?: boolean;
}

export const catalogVersion = "2026-10-01.1";
const RATES_AS_OF = "2026-09-23";
const openAiThinking = ["off", "low", "medium", "high", "xhigh", "max"] as const;
const vendorThinking = ["low", "medium", "high", "xhigh", "max"] as const;

export const models: readonly Model[] = [
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    vendor: "openai",
    openRouter: "openai/gpt-6.1-sol",
    source: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    rates: { native: [2, 10, 0.1, 2.5], gateway: [2, 10, 0.1, 2.5] },
    thinking: vendorThinking,
  },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    vendor: "openai",
    openRouter: "openai/gpt-6-astra",
    source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
    rates: { native: [10, 50, 1, 12.5], gateway: [10, 50, 1, 12.5] },
    thinking: vendorThinking,
    generation: true,
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    vendor: "openai",
    openRouter: "openai/gpt-6-sol",
    source: "https://developers.openai.com/api/docs/models/gpt-6-sol",
    rates: { native: [2, 10, 0.2, 2.5], gateway: [2, 10, 0.2, 2.5] },
    thinking: openAiThinking,
    generation: true,
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    vendor: "openai",
    openRouter: "openai/gpt-6-luna",
    source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
    rates: { native: [0.1, 0.5, 0.01, 0.125], gateway: [0.1, 0.5, 0.01, 0.125] },
    thinking: openAiThinking,
  },
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    vendor: "anthropic",
    openRouter: "anthropic/claude-fable-5.1",
    source: "https://platform.claude.com/docs/en/models/overview",
    rates: { native: [10, 50, 0.25, 12.5], gateway: [10, 50, 0.25, 12.5] },
    thinking: vendorThinking,
    generation: true,
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    vendor: "anthropic",
    openRouter: "anthropic/claude-opus-5.5",
    source: "https://platform.claude.com/docs/en/models/overview",
    rates: { native: [4, 20, 0.2, 5], gateway: [4, 20, 0.2, 5] },
    thinking: vendorThinking,
    generation: true,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    vendor: "anthropic",
    openRouter: "anthropic/claude-sonnet-5.5",
    source: "https://platform.claude.com/docs/en/models/sonnet-5-5/overview",
    rates: { native: [2, 10, 0.2, 2.5], gateway: [2, 10, 0.2, 2.5] },
    thinking: vendorThinking,
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    vendor: "anthropic",
    openRouter: "anthropic/claude-sonnet-5",
    source: "https://platform.claude.com/docs/en/models/overview",
    rates: { native: [2, 10, 0.2, 2.5], gateway: [2, 10, 0.2, 2.5] },
    thinking: vendorThinking,
  },
  {
    id: "glm-5.3",
    label: "GLM 5.3",
    openRouter: "z-ai/glm-5.3",
    source: "https://openrouter.ai/z-ai/glm-5.3",
    rates: { gateway: [0.84, 2.64, 0.156, 0.84] },
    thinking: ["low", "high", "max"],
    generation: true,
  },
  {
    id: "kimi-k3",
    label: "Kimi K3",
    openRouter: "moonshotai/kimi-k3",
    source: "https://openrouter.ai/moonshotai/kimi-k3",
    rates: { gateway: [3, 15, 0.3, 3] },
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

export function findModel(id: string): Model | undefined {
  return models.find((model) => model.id === id);
}

/** Reference pricing for running `model` on its vendor's own key. */
export function nativePricing(model: Model): ModelPricing | undefined {
  const rates = model.rates?.native;
  if (!rates) return undefined;
  const source =
    model.vendor === "anthropic"
      ? "https://platform.claude.com/docs/en/about-claude/pricing"
      : model.source;
  return ratesPricing(rates, source);
}

/** Pricing from `rates`, dated `asOf` or else as of the catalog's reference rates. */
export function ratesPricing(
  [input, output, cacheRead, cacheWrite]: Rates,
  source: string,
  asOf = RATES_AS_OF,
): ModelPricing {
  return { input, output, cacheRead, cacheWrite, source, asOf, maxInputTokens: 200_000 };
}
