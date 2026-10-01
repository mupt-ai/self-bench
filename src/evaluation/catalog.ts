import {
  chatgptSignInModels,
  findModel,
  type ModelPricing,
  models,
  nativePricing,
  type ThinkingLevel,
} from "../contracts/models.js";
import {
  catalogModelId,
  type GatewayId,
  gatewayIds,
  gatewayPricing,
  gateways,
  isGateway,
  listedModels,
} from "../gateways/index.js";
import type { Harness } from "./models.js";

export { catalogVersion } from "../contracts/models.js";

type CatalogProvider = "openai" | "anthropic" | GatewayId | "custom";

/** Evaluation's view of a catalog model: the credential it runs on and its native harnesses. */
export interface CatalogModel {
  id: string;
  provider: CatalogProvider;
  /** The model id the provider receives. */
  model: string;
  label: string;
  harnesses: Harness[];
  source: string;
  /** The model's id on each gateway that serves it; custom endpoints have none. */
  gateways?: Partial<Record<GatewayId, string>>;
  /** Selectable reasoning levels; absent means the provider default only. */
  thinking?: ThinkingLevel[];
  /**
   * For a model the catalog gives no levels, the levels each gateway accepts; its route there
   * offers those, and `thinking` shows the first gateway's.
   */
  gatewayThinking?: Partial<Record<GatewayId, ThinkingLevel[]>>;
  pricing?: ModelPricing;
}

const nativeHarnesses: Record<"openai" | "anthropic", Harness[]> = {
  openai: ["codex", "pi"],
  anthropic: ["claude-code", "pi"],
};

/** Reference metadata for labels, direct credentials and historical pricing; not gateway availability. */
export const catalog: CatalogModel[] = models.map((model) => {
  const provider = model.vendor ?? "openrouter";
  return {
    id: model.id,
    provider,
    model: model.vendor ? model.id : model.openRouter,
    label: model.label,
    harnesses: model.vendor ? [...nativeHarnesses[model.vendor]] : ["pi"],
    source: model.source,
    ...(model.thinking ? { thinking: [...model.thinking] } : {}),
  };
});

/** Only live gateway listings and explicit ChatGPT sign-in models are selectable. */
export function evaluationCatalog(): CatalogModel[] {
  const curated = new Map(catalog.map((model) => [findModel(model.id)?.openRouter, model]));
  const ownLevels = new Set(catalog.filter((model) => model.thinking).map((model) => model.id));
  const merged = new Map<string, CatalogModel>();
  for (const gateway of gatewayIds) {
    for (const entry of listedModels(gateway)) {
      const id = catalogModelId(gateway, entry.id);
      const known = merged.get(id) ?? curated.get(id);
      const model: CatalogModel = {
        ...(known ?? {
          id,
          provider: id.startsWith("openai/")
            ? "openai"
            : id.startsWith("anthropic/")
              ? "anthropic"
              : gateway,
          model:
            id.startsWith("openai/") || id.startsWith("anthropic/")
              ? id.slice(id.indexOf("/") + 1)
              : entry.id,
          label: entry.label,
          harnesses: ["pi"],
          source: gateways[gateway].modelPage(entry.id),
        }),
        gateways: { ...known?.gateways, [gateway]: entry.id },
      };
      if (!ownLevels.has(model.id)) {
        const levels = entry.thinking ? [...entry.thinking] : [];
        model.gatewayThinking = { ...known?.gatewayThinking, [gateway]: levels };
        const shown = known?.thinking ?? (levels.length ? levels : undefined);
        if (shown) model.thinking = shown;
      }
      merged.set(id, model);
    }
  }
  for (const model of catalog)
    if (
      chatgptSignInModels.has(model.id) &&
      ![...merged.values()].some((entry) => entry.id === model.id)
    )
      merged.set(model.id, { ...model, gateways: {} });
  return [...merged.values()];
}

/** The model with its reference pricing on its own provider, when the catalog has rates. */
export function withReferencePricing(model: CatalogModel): CatalogModel {
  const entry = findModel(model.id);
  const pricing = isGateway(model.provider)
    ? gatewayPricing(model.provider, model.model, entry?.rates?.gateway)
    : entry && nativePricing(entry);
  return pricing ? { ...model, pricing } : model;
}

export const hostedSandboxes = ["e2b", "modal", "daytona"] as const;
export type HostedSandbox = (typeof hostedSandboxes)[number];
