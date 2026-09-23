import { type CatalogModel, withReferencePricing } from "./catalog.js";

export const harnessIds = ["codex", "claude-code", "pi", "mini-swe-agent", "terminus-2"] as const;
export type Harness = (typeof harnessIds)[number];
export const harnessLabels: Record<Harness, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  pi: "Pi",
  "mini-swe-agent": "Mini-SWE-Agent",
  "terminus-2": "Terminus 2",
};
export const harnessOptions = harnessIds.map((id) => ({ id, label: harnessLabels[id] }));

export const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export function evaluationTaskKey(runId: string, taskId: string): string {
  return JSON.stringify([runId, taskId]);
}

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

const modelThinkingLevels: Record<string, ThinkingLevel[]> = {
  "z-ai/glm-5.3": ["default", "low", "high", "max"],
  "z-ai/glm-5.3-flash": ["default", "low", "high", "max"],
  "deepseek/deepseek-v4-pro": ["default", "off", "low", "high", "max"],
  "deepseek/deepseek-v4-flash-0731": ["default", "off", "low", "high", "max"],
  "deepseek/deepseek-v4.1-flash": ["default", "off", "low", "high", "xhigh", "max"],
};

/** Harnesses a direct provider key can drive; only OpenRouter is remapped for the rest. */
const providerHarnesses: Partial<Record<CatalogModel["provider"], Harness[]>> = {
  openai: ["codex", "pi", "mini-swe-agent", "terminus-2"],
  anthropic: ["claude-code", "pi", "mini-swe-agent", "terminus-2"],
};

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
  const nativeHarnesses = providerHarnesses[model.provider] ?? providerHarnesses.openai ?? [];
  const { pricing: _pricing, ...gatewayModel } = model;
  return [
    ...(model.provider !== "openrouter"
      ? [withReferencePricing({ ...model, harnesses: [...nativeHarnesses] })]
      : []),
    ...(model.provider === "custom"
      ? [{ ...gatewayModel, provider: "openai" as const, harnesses: [...nativeHarnesses] }]
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
  // Custom endpoints are typed in by the user; the level table only describes catalog IDs.
  const configured = model.provider === "custom" ? undefined : modelThinkingLevels[model.model];
  if (!configured && !routedModels[model.id]) return ["default"];
  const levels: ThinkingLevel[] = configured
    ? [...configured]
    : ["default", "low", "medium", "high", "xhigh", "max"];
  if (!configured && model.id.startsWith("openai-") && model.id !== "openai-astra6")
    levels.unshift("off");
  return levels.filter(
    (level) => level !== "default" && (!harnesses.includes("pi") || level !== "max"),
  );
}

export function thinkingArguments(harness: Harness, level?: ThinkingLevel): string[] {
  if (!level || level === "default") return [];
  const name = harness === "pi" ? "thinking" : "reasoning_effort";
  const value = harness === "codex" && level === "off" ? "none" : level;
  return ["--agent-kwarg", `${name}=${value}`];
}
