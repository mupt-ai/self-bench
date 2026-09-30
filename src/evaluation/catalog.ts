import {
  findModel,
  listedOpenRouterModels,
  type ModelPricing,
  modelPricing,
  models,
  openRouterPricing,
  type ThinkingLevel,
} from "../contracts/models.js";
import type { Harness } from "./models.js";

export { catalogVersion } from "../contracts/models.js";

type CatalogProvider = "openai" | "anthropic" | "openrouter" | "custom";

/** Evaluation's view of a catalog model: the credential it runs on and its native harnesses. */
export interface CatalogModel {
  id: string;
  provider: CatalogProvider;
  /** The model id the provider receives. */
  model: string;
  label: string;
  harnesses: Harness[];
  source: string;
  /** The model's OpenRouter id; custom endpoints have none. */
  openRouter?: string;
  /** Selectable reasoning levels; absent means the provider default only. */
  thinking?: ThinkingLevel[];
  pricing?: ModelPricing;
}

const nativeHarnesses: Record<CatalogProvider, Harness[]> = {
  openai: ["codex", "pi"],
  anthropic: ["claude-code", "pi"],
  openrouter: ["pi"],
  custom: ["pi"],
};

/** The curated models, which keep their short ids and their vendors' own credentials. */
export const catalog: CatalogModel[] = models.map((model) => {
  const provider = model.vendor ?? "openrouter";
  return {
    id: model.id,
    provider,
    model: model.vendor ? model.id : model.openRouter,
    label: model.label,
    harnesses: [...nativeHarnesses[provider]],
    source: model.source,
    openRouter: model.openRouter,
    ...(model.thinking ? { thinking: [...model.thinking] } : {}),
  };
});

/**
 * Every model OpenRouter lists for agents, frontier first. A curated model takes its place
 * in that order and keeps its own levels, falling back to OpenRouter's; curated models OpenRouter
 * does not list follow at the end. Before the first load it is the curated catalog alone.
 */
export function evaluationCatalog(): CatalogModel[] {
  const curated = new Map(catalog.map((model) => [model.openRouter, model]));
  const listed = listedOpenRouterModels().map((entry): CatalogModel => {
    const known = curated.get(entry.id);
    curated.delete(entry.id);
    const thinking = known?.thinking ?? (entry.thinking && [...entry.thinking]);
    return {
      ...(known ?? {
        id: entry.id,
        provider: "openrouter",
        model: entry.id,
        label: entry.label,
        harnesses: [...nativeHarnesses.openrouter],
        source: `https://openrouter.ai/${entry.id}`,
        openRouter: entry.id,
      }),
      ...(thinking ? { thinking } : {}),
    };
  });
  return [...listed, ...curated.values()];
}

/** The model with its reference pricing on its own provider, when the catalog has rates. */
export function withReferencePricing(model: CatalogModel): CatalogModel {
  const entry = findModel(model.id);
  const pricing =
    model.provider === "openrouter"
      ? openRouterPricing(model.openRouter ?? model.model, entry?.rates?.openRouter)
      : entry && modelPricing(entry, "native");
  return pricing ? { ...model, pricing } : model;
}

export const hostedSandboxes = ["e2b", "modal", "daytona"] as const;
export type HostedSandbox = (typeof hostedSandboxes)[number];
