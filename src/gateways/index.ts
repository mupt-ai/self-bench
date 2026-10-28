/**
 * Model gateways: one key that reaches every vendor's models. Each serves the catalog's models
 * under its own ids, which the catalog spells as OpenRouter does (catalogModelId, gatewayModelId).
 * Server processes load each gateway's live models and list prices from @mupt-ai/dari-gateway's
 * catalog (refresh.ts); until then, and in the browser, only curated models route through them,
 * at reference rates.
 */
import {
  type ModelPricing,
  type PromptTiers,
  type Rates,
  ratesPricing,
  type ThinkingLevel,
} from "../contracts/models.js";

/** A model a gateway lists that a coding agent can drive. */
export interface ListedModel {
  /** The gateway's id for it. */
  readonly id: string;
  readonly label: string;
  /** The reasoning efforts the gateway says it accepts, in display order. */
  readonly thinking?: readonly ThinkingLevel[];
  /**
   * Pi's models.json entry for it. Pi guesses at a model its catalog lacks, and its own entry can
   * still take thinking as the gateway does not, so generation gives Pi the whole entry or only
   * its thinking (piModels). Evaluation trials read its limits.
   */
  readonly pi?: PiModel;
}

/** A model in Pi's models.json (Pi's docs/models.md); what is left out takes Pi's defaults. */
export interface PiModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** $ per million tokens. */
  readonly cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Pi's thinking levels to the efforts the endpoint takes. */
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string>>>;
  readonly compat?: Readonly<Record<string, boolean>>;
}

/** A gateway's list price for one model, with what it charges longer prompts. */
export interface ListedRates extends PromptTiers {
  readonly rates: Rates;
  readonly asOf: string;
}

/** A gateway's agent-capable models and its prices. */
export interface GatewayListing {
  readonly models: readonly ListedModel[];
  /** List prices by the gateway's model id. */
  readonly rates: ReadonlyMap<string, ListedRates>;
}

/**
 * One API key that reaches every vendor's models. Its id (the key of `gateways`) is also its
 * credential kind and Pi's provider name for it.
 */
interface Gateway {
  readonly label: string;
  /** The variable its key travels under, for Pi in generation. */
  readonly keyVariable: string;
  /**
   * Vendors it spells differently from the catalog, which spells them as OpenRouter does: its
   * spelling to the catalog's ("zai" to "z-ai").
   */
  readonly vendorAliases?: Readonly<Record<string, string>>;
  /** The page describing a model, by the gateway's id for it. */
  modelPage(id: string): string;
}

/** Gateways in the order the model picker merges their models. */
export const gateways = {
  openrouter: {
    label: "OpenRouter",
    keyVariable: "OPENROUTER_API_KEY",
    modelPage: (id) => `https://openrouter.ai/${id}`,
  },
  "vercel-ai-gateway": {
    label: "Vercel AI Gateway",
    keyVariable: "AI_GATEWAY_API_KEY",
    vendorAliases: {
      alibaba: "qwen",
      bytedance: "bytedance-seed",
      meta: "meta-llama",
      mistral: "mistralai",
      spacexai: "x-ai",
      zai: "z-ai",
    },
    // Model pages drop the vendor: /ai-gateway/models/glm-5.3.
    modelPage: (id) => `https://vercel.com/ai-gateway/models/${id.slice(id.indexOf("/") + 1)}`,
  },
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

/** The gateway's listed model by the gateway's own id for it. */
function listedModel(gateway: GatewayId, id: string): ListedModel | undefined {
  return listing(gateway).models.find((entry) => entry.id === id);
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
  return listedModel(gateway, id)?.pi;
}

function piThinking({ thinkingLevelMap, compat }: PiModel): object | undefined {
  const thinking = {
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(compat?.forceAdaptiveThinking ? { compat: { forceAdaptiveThinking: true } } : {}),
  };
  return Object.keys(thinking).length ? thinking : undefined;
}

/**
 * Whether the gateway serves its model `id`: it prices or lists it (including variable-price
 * routers), or its prices have not loaded yet, when curated models are assumed to be served.
 */
export function gatewayServes(gateway: GatewayId, id: string): boolean {
  const { rates, models } = listing(gateway);
  return rates.size === 0 || rates.has(id) || models.some((model) => model.id === id);
}

/** The catalog's id for the model a gateway names `id`. */
export function catalogModelId(gateway: GatewayId, id: string): string {
  const { vendorAliases = {} }: Gateway = gateways[gateway];
  return respell(id, (vendor) => vendorAliases[vendor]);
}

/** The gateway's id for the catalog's model `id`. */
export function gatewayModelId(gateway: GatewayId, id: string): string {
  const { vendorAliases = {} }: Gateway = gateways[gateway];
  const aliases = Object.entries(vendorAliases);
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
 * The variable a model provider's API key travels under, for Pi and a harness that calls its
 * provider directly. OpenAI-compatible providers (OpenAI, custom endpoints) share OPENAI_API_KEY.
 */
export function modelApiKeyVariable(provider: string): string {
  if (isGateway(provider)) return gateways[provider].keyVariable;
  if (provider === "meta") return "META_API_KEY";
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}
