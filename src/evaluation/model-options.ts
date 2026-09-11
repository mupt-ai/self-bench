import type { CatalogModel } from "./catalog.js";
import { withReferencePricing } from "./catalog-pricing.js";
import { harnessIds } from "./harnesses.js";
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
  const routed =
    routedModels[model.id] ??
    (model.provider === "openrouter" || model.provider === "custom"
      ? model.model
      : `${model.provider}/${model.model}`);
  const nativeHarnesses: Harness[] =
    model.provider === "openai"
      ? ["codex", "pi", "mini-swe-agent", "terminus-2"]
      : model.provider === "anthropic"
        ? ["claude-code", "pi", "mini-swe-agent", "terminus-2"]
        : model.harnesses;
  const { pricing: _pricing, ...gatewayModel } = model;
  return [
    ...(model.provider !== "openrouter"
      ? [withReferencePricing({ ...model, harnesses: nativeHarnesses })]
      : []),
    ...(model.provider === "custom"
      ? [
          {
            ...gatewayModel,
            provider: "openai" as const,
            harnesses: ["codex", "pi", "mini-swe-agent", "terminus-2"] as Harness[],
          },
        ]
      : []),
    withReferencePricing({
      ...gatewayModel,
      id: model.id.replace(/^(openai|anthropic)-/, "router-"),
      provider: "openrouter",
      model: routed,
      harnesses: [...harnessIds],
    }),
  ];
}

export function routeFor(model: CatalogModel, provider: string) {
  return modelRoutes(model).find((route) => route.provider === provider);
}

export function thinkingOptions(model: CatalogModel, harnesses: Harness[]): ThinkingLevel[] {
  if (harnesses.some((harness) => harness === "mini-swe-agent" || harness === "terminus-2"))
    return ["default"];
  if (!routedModels[model.id]) return ["default"];
  const levels: ThinkingLevel[] = ["default", "low", "medium", "high", "xhigh", "max"];
  if (model.id.startsWith("openai-") && model.id !== "openai-astra6") levels.unshift("off");
  return harnesses.includes("pi") ? levels.filter((level) => level !== "max") : levels;
}

export function thinkingArguments(harness: Harness, level?: ThinkingLevel): string[] {
  if (!level || level === "default") return [];
  const name = harness === "pi" ? "thinking" : "reasoning_effort";
  const value = harness === "codex" && level === "off" ? "none" : level;
  return ["--agent-kwarg", `${name}=${value}`];
}
