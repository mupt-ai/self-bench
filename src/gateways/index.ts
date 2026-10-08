/**
 * Model gateways: one key that reaches every vendor's models. Each serves the catalog's models
 * under its own ids, which the catalog spells as OpenRouter does (catalogModelId, gatewayModelId).
 * Server processes load each gateway's live models and list prices (refresh.ts); until then,
 * and in the browser, only curated models route through them, at reference rates.
 */
import {
  type ModelPricing,
  type PromptTiers,
  type Rates,
  ratesPricing,
} from "../contracts/models.js";
import type { Gateway, GatewayListing, ListedModel, PiModel } from "./gateway.js";
import { openRouter } from "./openrouter.js";
import { vercelAiGateway } from "./vercel-ai-gateway.js";

export type { ListedModel } from "./gateway.js";

/** Gateways in the order the model picker merges their models. */
export const gateways = {
  openrouter: openRouter,
  "vercel-ai-gateway": vercelAiGateway,
} as const satisfies Record<string, Gateway>;
export type GatewayId = keyof typeof gateways;
export const gatewayIds = Object.keys(gateways) as GatewayId[];

export function isGateway(provider: string | undefined): provider is GatewayId {
  return provider !== undefined && Object.hasOwn(gateways, provider);
}

/** A loaded listing, with its models also keyed by catalog id. */
interface Loaded extends GatewayListing {
  readonly byCatalogId: ReadonlyMap<string, ListedModel>;
}

const EMPTY: Loaded = { models: [], rates: new Map(), byCatalogId: new Map() };
const listings = new Map<GatewayId, Loaded>();

export function setGatewayListing(gateway: GatewayId, { models, rates }: GatewayListing): void {
  const byCatalogId = new Map(models.map((model) => [catalogModelId(gateway, model.id), model]));
  listings.set(gateway, { models, rates, byCatalogId });
}

function listing(gateway: GatewayId): Loaded {
  return listings.get(gateway) ?? EMPTY;
}

/** The gateway's agent-capable models, frontier first; empty until a server process loads them. */
export function listedModels(gateway: GatewayId): readonly ListedModel[] {
  return listing(gateway).models;
}

/** A listed model by its catalog id, from the first gateway that lists it. */
export function findListedModel(id: string): ListedModel | undefined {
  for (const gateway of gatewayIds) {
    const listed = listing(gateway).byCatalogId.get(id);
    if (listed) return listed;
  }
  return undefined;
}

/**
 * Pi's models.json for the gateway's model `id`, when its listing describes the model to Pi
 * (ListedModel.pi); the gateway's id is Pi's provider name for it. The whole entry is for a Pi
 * whose catalog lacks the model; a Pi that lists it keeps its own entry, overriding only how it
 * asks for thinking.
 */
export function piModels(gateway: GatewayId, id: string): object | undefined {
  const model = listedPiModel(gateway, id);
  if (!model) return undefined;
  const thinking = piThinking(model);
  return {
    providers: {
      [gateway]: {
        models: [model],
        ...(thinking ? { modelOverrides: { [model.id]: thinking } } : {}),
      },
    },
  };
}

/** The part of piModels for a Pi that lists the model itself: only how it asks for thinking. */
export function piModelOverrides(gateway: GatewayId, id: string): object | undefined {
  const model = listedPiModel(gateway, id);
  const thinking = model && piThinking(model);
  return thinking && { providers: { [gateway]: { modelOverrides: { [model.id]: thinking } } } };
}

function listedPiModel(gateway: GatewayId, id: string): PiModel | undefined {
  return listing(gateway).models.find((entry) => entry.id === id)?.pi;
}

function piThinking({ thinkingLevelMap, compat }: PiModel): object | undefined {
  const thinking = {
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(compat?.forceAdaptiveThinking ? { compat: { forceAdaptiveThinking: true } } : {}),
  };
  return Object.keys(thinking).length ? thinking : undefined;
}

/**
 * Whether the gateway serves its model `id`: it prices it, or its prices have not loaded yet (and
 * in the browser), when a curated model is assumed to be on every gateway.
 */
export function gatewayServes(gateway: GatewayId, id: string): boolean {
  const { rates } = listing(gateway);
  return rates.size === 0 || rates.has(id);
}

/** The catalog's id for the model a gateway names `id`. */
export function catalogModelId(gateway: GatewayId, id: string): string {
  const aliases: Readonly<Record<string, string>> = gateways[gateway].vendorAliases ?? {};
  return respell(id, (vendor) => aliases[vendor]);
}

/** The gateway's id for the catalog's model `id`. */
export function gatewayModelId(gateway: GatewayId, id: string): string {
  const aliases = Object.entries(gateways[gateway].vendorAliases ?? {});
  return respell(id, (vendor) => aliases.find(([, catalog]) => catalog === vendor)?.[0]);
}

function respell(id: string, alias: (vendor: string) => string | undefined): string {
  const slash = id.indexOf("/");
  const vendor = slash > 0 ? alias(id.slice(0, slash)) : undefined;
  return vendor ? `${vendor}${id.slice(slash)}` : id;
}

/**
 * The gateway's live list price for its model `id`, else the `reference` rates, with the
 * reference long-context tiers beyond them.
 */
export function gatewayPricing(
  gateway: GatewayId,
  id: string,
  reference?: Rates,
  referenceTiers?: PromptTiers,
): ModelPricing | undefined {
  const page = gateways[gateway].modelPage(id);
  const live = listing(gateway).rates.get(id);
  if (live) return ratesPricing(live.rates, page, live.asOf, live);
  return reference && ratesPricing(reference, page, undefined, referenceTiers);
}

/**
 * The variable a model provider's API key travels under, for Pi and every Harbor harness.
 * OpenAI-compatible providers (OpenAI, Codex, custom endpoints) share OPENAI_API_KEY.
 */
export function modelApiKeyVariable(provider: string): string {
  if (isGateway(provider)) return gateways[provider].keyVariable;
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}
