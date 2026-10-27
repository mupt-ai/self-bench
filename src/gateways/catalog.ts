import { type CatalogModel, type CatalogModelPrice, listModelCatalog } from "@mupt-ai/dari-gateway";
import { pi } from "@mupt-ai/dari-gateway/providers/pi";
import { modelIdPattern, type RateTier } from "../contracts/models.js";
import type { GatewayModelConfig, GatewayModelPrice } from "../gateway/platform.js";
import {
  type GatewayId,
  type GatewayListing,
  gatewayIds,
  gateways,
  type ListedModel,
  type ListedRates,
  type PiModel,
  setGatewayListing,
} from "./index.js";

/**
 * The models SelfBench offers and prices, from @mupt-ai/dari-gateway's catalog: each gateway's
 * live listing (OpenRouter, Vercel AI Gateway), and Pi's own catalog for the providers a trial can
 * reach on their own keys. Server processes only; the browser sees the curated catalog.
 */

const REFRESH_MS = 60 * 60 * 1000;

/** Every catalog model by the gateway's `provider/model` id. */
const entries = new Map<string, CatalogModel>();
for (const model of await listModelCatalog({ providers: ["openai", "anthropic", "meta"] }))
  entries.set(model.id, model);

/** The catalog's entry for the gateway's model id `provider/model`. */
export function catalogEntry(model: string): CatalogModel | undefined {
  return entries.get(model);
}

/** The model's list price, as the gateway takes it; undefined when the catalog has none. */
export function gatewayModelPrice(model: string): GatewayModelPrice | undefined {
  return catalogEntry(model)?.price ?? undefined;
}

/**
 * A gateway's model as the catalog describes it, when Pi's catalog, which the gateway reads first,
 * lacks it: its provider, native id, API, limits, thinking levels and price.
 */
export function listedModelConfig(model: string): GatewayModelConfig | undefined {
  const entry = catalogEntry(model);
  if (!entry || !(gatewayIds as string[]).includes(entry.provider)) return undefined;
  if (pi.getModel?.(entry.provider, entry.native_model_id)) return undefined;
  return {
    provider: entry.provider,
    native_model_id: entry.native_model_id,
    // Gateways speak OpenAI Chat Completions to every vendor (as Pi reaches them).
    api: "openai-completions",
    context_window: entry.context_window,
    max_output_tokens: entry.max_output_tokens,
    supported_thinking_levels: entry.thinking_levels,
    cost: entry.price ?? { input: 0, output: 0 },
  };
}

/**
 * Loads a gateway's models and list prices. A failed load, or one with no prices or no models a
 * harness can drive, keeps the last good one.
 */
export async function refreshGateway(
  gateway: GatewayId,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { label } = gateways[gateway];
  const models = await listModelCatalog({
    providers: [gateway],
    fetch: fetcher,
    signal: AbortSignal.timeout(10_000),
  });
  const listing = gatewayListing(gateway, models);
  if (!listing.rates.size) throw new Error(`${label} returned no prices`);
  if (!listing.models.length) throw new Error(`${label} returned no models agents can drive`);
  for (const id of entries.keys()) if (id.startsWith(`${gateway}/`)) entries.delete(id);
  for (const model of models) entries.set(model.id, model);
  setGatewayListing(gateway, listing);
}

/**
 * Loads every gateway now and hourly. Each fails on its own: the failure is logged and that
 * gateway's last good listing stays in use.
 */
export function keepGatewaysFresh(): { ready: Promise<void>; stop(): void } {
  const refresh = async () => {
    await Promise.all(
      gatewayIds.map((gateway) =>
        refreshGateway(gateway).catch((error: unknown) =>
          console.warn(
            `${gateways[gateway].label} catalog refresh failed; keeping the current catalog`,
            error,
          ),
        ),
      ),
    );
  };
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();
  return { ready: refresh(), stop: () => clearInterval(timer) };
}

/**
 * A gateway's listing from its catalog models, in the catalog's order. Variants (`:free`, ...)
 * and OpenRouter's own routers are left out of the picker, but keep their prices.
 */
function gatewayListing(gateway: GatewayId, models: readonly CatalogModel[]): GatewayListing {
  const rates = new Map<string, ListedRates>();
  const listed: ListedModel[] = [];
  for (const model of models) {
    const id = model.native_model_id;
    if (model.price) rates.set(id, listedRates(model.price, model.price_as_of.slice(0, 10)));
    if (!modelIdPattern.test(id) || id.includes(":") || id.startsWith("openrouter/")) continue;
    // A model that cannot reason lists only "off", which offers no choice.
    const thinking = model.thinking_levels.some((level) => level !== "off")
      ? model.thinking_levels
      : [];
    listed.push({
      id,
      // OpenRouter's names lead with the vendor: "MoonshotAI: Kimi K3" is "Kimi K3".
      label: model.name.replace(/^[^:]+:\s*/, "").trim() || id,
      ...(thinking.length ? { thinking } : {}),
      ...(gateway === "vercel-ai-gateway" ? { pi: piModel(model, thinking) } : {}),
    });
  }
  return { rates, models: listed };
}

/**
 * A catalog price as SelfBench records rates. A cache price the base leaves out follows the input
 * price; one the base lists must be listed for a long-context tier too, or pricing stops there.
 */
function listedRates(price: CatalogModelPrice, asOf: string): ListedRates {
  const longContext: RateTier[] = [];
  let unpricedFrom: number | undefined;
  const tiers = [...price.tiers].sort((a, b) => a.input_tokens_above - b.input_tokens_above);
  for (const tier of tiers) {
    const from = tier.input_tokens_above + 1;
    if (longContext.at(-1)?.from === from) continue;
    const read = tier.cached_input ?? (price.cached_input === null ? tier.input : undefined);
    const write = tier.cache_write ?? (price.cache_write === null ? tier.input : undefined);
    if (read === undefined || write === undefined) {
      unpricedFrom = from;
      break;
    }
    longContext.push({ from, rates: [tier.input, tier.output, read, write] });
  }
  return {
    rates: [
      price.input,
      price.output,
      price.cached_input ?? price.input,
      price.cache_write ?? price.input,
    ],
    asOf,
    ...(longContext.length ? { longContext } : {}),
    ...(unpricedFrom ? { unpricedFrom } : {}),
  };
}

/**
 * Pi reaches Vercel AI Gateway over Anthropic Messages. Pi asks a model its catalog lacks for a
 * thinking budget, which the gateway cannot pass to some vendors (Mistral: "invalid mistral
 * provider options"), while every model that lists efforts takes adaptive thinking with an effort.
 */
function piModel(model: CatalogModel, thinking: readonly string[]): PiModel {
  // Anthropic Messages has no minimal effort, so Pi keeps its own mapping (to low) for it.
  const efforts = thinking.filter((level) => level !== "off" && level !== "minimal");
  const { price } = model;
  return {
    id: model.native_model_id,
    name: model.name,
    reasoning: thinking.length > 0,
    input: model.input_modalities.includes("image") ? ["text", "image"] : ["text"],
    ...(model.context_window ? { contextWindow: model.context_window } : {}),
    ...(model.max_output_tokens ? { maxTokens: model.max_output_tokens } : {}),
    ...(price
      ? {
          cost: {
            input: price.input,
            output: price.output,
            cacheRead: price.cached_input ?? price.input,
            cacheWrite: price.cache_write ?? price.input,
          },
        }
      : {}),
    ...(efforts.length
      ? { thinkingLevelMap: Object.fromEntries(efforts.map((level) => [level, level])) }
      : {}),
    // The gateway returns other vendors' reasoning without Anthropic's signatures, and takes it
    // back so; Pi would otherwise replay it as text.
    compat: {
      allowEmptySignature: true,
      ...(efforts.length ? { forceAdaptiveThinking: true } : {}),
    },
  };
}
