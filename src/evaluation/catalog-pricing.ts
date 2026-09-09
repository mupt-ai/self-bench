import type { CatalogModel } from "./catalog.js";

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
};

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
