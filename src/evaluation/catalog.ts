import { findModel, type ModelPricing, modelPricing, models } from "../contracts/models.js";
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
  pricing?: ModelPricing;
}

const nativeHarnesses: Record<CatalogProvider, Harness[]> = {
  openai: ["codex", "pi"],
  anthropic: ["claude-code", "pi"],
  openrouter: ["pi"],
  custom: ["pi"],
};

export const catalog: CatalogModel[] = models.map((model) => {
  const provider = model.vendor ?? "openrouter";
  return {
    id: model.id,
    provider,
    model: model.vendor ? model.id : model.openRouter,
    label: model.label,
    harnesses: [...nativeHarnesses[provider]],
    source: model.source,
  };
});

/** The model with its reference pricing on its own provider, when the catalog has rates. */
export function withReferencePricing(model: CatalogModel): CatalogModel {
  const entry = findModel(model.id);
  const pricing =
    entry && modelPricing(entry, model.provider === "openrouter" ? "openRouter" : "native");
  return pricing ? { ...model, pricing } : model;
}

export const hostedSandboxes = ["e2b", "modal", "daytona"] as const;
export type HostedSandbox = (typeof hostedSandboxes)[number];
