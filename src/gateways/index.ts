/**
 * Model gateways: one key that reaches every vendor's models. Each serves the catalog's models
 * under its own ids, which the catalog spells as OpenRouter does (catalogModelId, gatewayModelId).
 * Server processes load each gateway's live models and list prices (refresh.ts).
 * Until a listing loads, it offers no models; a reference price alone is not a route.
 */
import { type ModelPricing, type Rates, ratesPricing } from "../contracts/models.js";
import type { Gateway, GatewayListing, ListedModel } from "./gateway.js";
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

/** The gateway's live list price for its model `id`, else the `reference` rates. */
export function gatewayPricing(
  gateway: GatewayId,
  id: string,
  reference?: Rates,
): ModelPricing | undefined {
  const live = listing(gateway).rates.get(id);
  const rates = live?.rates ?? reference;
  return rates && ratesPricing(rates, gateways[gateway].modelPage(id), live?.asOf);
}

/**
 * The variable a model provider's API key travels under, for Pi and every Harbor harness.
 * OpenAI-compatible providers (OpenAI, Codex, custom endpoints) share OPENAI_API_KEY.
 */
export function modelApiKeyVariable(provider: string): string {
  if (isGateway(provider)) return gateways[provider].keyVariable;
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}
