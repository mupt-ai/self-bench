import {
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
  gatewayModelId,
  gatewayPricing,
  gatewayServes,
  gateways,
  isGateway,
  listedModels,
} from "../gateways/index.js";
import type { Harness } from "./models.js";

export { catalogVersion } from "../contracts/models.js";

export type CatalogProvider = "openai" | "anthropic" | GatewayId | "custom";

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

/**
 * The curated models, which keep their short ids and their vendors' own credentials, and run
 * through every gateway.
 */
export const catalog: CatalogModel[] = models.map((model) => {
  const provider = model.vendor ?? "openrouter";
  return {
    id: model.id,
    provider,
    model: model.vendor ? model.id : model.openRouter,
    label: model.label,
    harnesses: model.vendor ? [...nativeHarnesses[model.vendor]] : ["pi"],
    source: model.source,
    gateways: Object.fromEntries(
      gatewayIds.map((gateway) => [gateway, gatewayModelId(gateway, model.openRouter)]),
    ),
    ...(model.thinking ? { thinking: [...model.thinking] } : {}),
  };
});

/**
 * Every model the gateways list for agents: each gateway's in its order, frontier first, the
 * earlier gateways' first. A model two gateways list is one entry with a route on each. A curated
 * model takes its place in that order and keeps its own levels, or else takes each gateway's;
 * curated models no gateway lists follow at the end. A curated model loses its route on a
 * gateway whose prices have loaded without it. Before the first load it is the curated catalog.
 */
export function evaluationCatalog(): CatalogModel[] {
  const curated = new Map(
    catalog.map((model) => [findModel(model.id)?.openRouter ?? model.id, served(model)]),
  );
  const ownLevels = new Set(catalog.filter((model) => model.thinking).map((model) => model.id));
  const merged = new Map<string, CatalogModel>();
  for (const gateway of gatewayIds) {
    for (const entry of listedModels(gateway)) {
      const id = catalogModelId(gateway, entry.id);
      const known = merged.get(id) ?? curated.get(id);
      curated.delete(id);
      const model: CatalogModel = {
        ...(known ?? {
          id,
          provider: gateway,
          model: entry.id,
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
  return [...merged.values(), ...curated.values()];
}

/** A curated model with routes only on the gateways that serve it. */
function served(model: CatalogModel): CatalogModel {
  const routes = gatewayIds.flatMap((gateway) => {
    const id = model.gateways?.[gateway];
    return id && gatewayServes(gateway, id) ? [[gateway, id] as const] : [];
  });
  return { ...model, gateways: Object.fromEntries(routes) };
}

/** Reference pricing for catalog model `id` on `provider`, which names it `model`. */
export function referencePricing(
  id: string,
  provider: CatalogProvider,
  model: string,
): ModelPricing | undefined {
  const entry = findModel(id);
  return isGateway(provider)
    ? gatewayPricing(provider, model, entry?.rates?.gateway, entry?.longContextFrom)
    : entry && nativePricing(entry);
}

/** The model with its reference pricing on its own provider, when the catalog has rates. */
export function withReferencePricing(model: CatalogModel): CatalogModel {
  const pricing = referencePricing(model.id, model.provider, model.model);
  return pricing ? { ...model, pricing } : model;
}

export const hostedSandboxes = ["e2b", "modal", "daytona"] as const;
export type HostedSandbox = (typeof hostedSandboxes)[number];
