import { findModel, type ThinkingLevel } from "../contracts/models.js";
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

/** Harnesses a direct provider key can drive; only OpenRouter is remapped for the rest. */
const providerHarnesses: Partial<Record<CatalogModel["provider"], Harness[]>> = {
  openai: ["codex", "pi", "mini-swe-agent", "terminus-2"],
  anthropic: ["claude-code", "pi", "mini-swe-agent", "terminus-2"],
};

/** Every credential route for a model: its native provider (if any) and OpenRouter. */
export function modelRoutes(model: CatalogModel): CatalogModel[] {
  const entry = model.provider === "custom" ? undefined : findModel(model.id);
  const routed =
    entry?.openRouter ??
    (model.provider === "openrouter" || model.provider === "custom"
      ? model.model
      : `${model.provider}/${model.model}`);
  const native = providerHarnesses[model.provider] ?? providerHarnesses.openai ?? [];
  const { pricing: _pricing, ...gatewayModel } = model;
  return [
    ...(model.provider !== "openrouter"
      ? [withReferencePricing({ ...model, harnesses: [...native] })]
      : []),
    ...(model.provider === "custom"
      ? [{ ...gatewayModel, provider: "openai" as const, harnesses: [...native] }]
      : []),
    withReferencePricing({
      ...gatewayModel,
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
  // Custom endpoints are typed in by the user; the catalog only describes its own models.
  const levels = model.provider === "custom" ? undefined : findModel(model.id)?.thinking;
  if (!levels) return ["default"];
  return levels.filter((level) => !harnesses.includes("pi") || level !== "max");
}

export function thinkingArguments(harness: Harness, level?: ThinkingLevel): string[] {
  if (!level || level === "default") return [];
  const name = harness === "pi" ? "thinking" : "reasoning_effort";
  const value = harness === "codex" && level === "off" ? "none" : level;
  return ["--agent-kwarg", `${name}=${value}`];
}
