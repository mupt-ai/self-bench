import type { CatalogModel } from "./catalog.js";
import { withReferencePricing } from "./catalog-pricing.js";
import type { Harness } from "./types.js";

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

const routedModels: Record<string, string> = {
  "openai-astra6": "openai/gpt-6-astra",
  "openai-sol56": "openai/gpt-5.6-sol",
  "openai-terra56": "openai/gpt-5.6-terra",
  "openai-luna56": "openai/gpt-5.6-luna",
  "anthropic-fable51": "anthropic/claude-fable-5.1",
  "anthropic-opus5": "anthropic/claude-opus-5",
  "anthropic-sonnet5": "anthropic/claude-sonnet-5",
};

export function modelRoutes(model: CatalogModel): CatalogModel[] {
  const routed = routedModels[model.id];
  return [
    withReferencePricing(model),
    ...(routed
      ? [
          withReferencePricing({
            label: model.label,
            id: model.id.replace(/^(openai|anthropic)-/, "router-"),
            provider: "openrouter",
            model: routed,
            harnesses: ["pi"],
            source: `https://openrouter.ai/${routed}`,
          }),
        ]
      : []),
  ];
}

export function routeFor(model: CatalogModel, provider: string) {
  return modelRoutes(model).find((route) => route.provider === provider);
}

export function thinkingOptions(model: CatalogModel, harnesses: Harness[]): ThinkingLevel[] {
  if (!routedModels[model.id]) return ["default"];
  const levels: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
  if (model.id.startsWith("openai-") && model.id !== "openai-astra6") levels.unshift("off");
  return harnesses.includes("pi") ? levels.filter((level) => level !== "max") : levels;
}

export function thinkingArguments(harness: Harness, level?: ThinkingLevel): string[] {
  if (!level || level === "default") return [];
  const name = harness === "pi" ? "thinking" : "reasoning_effort";
  const value = harness === "codex" && level === "off" ? "none" : level;
  return ["--agent-kwarg", `${name}=${value}`];
}
