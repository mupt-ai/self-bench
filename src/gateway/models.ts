import { pi } from "@mupt-ai/dari-gateway/providers/pi";
import { findModel, type ModelPricing, nativePricing } from "../contracts/models.js";
import { gatewayPricing, isGateway, listedModel } from "../gateways/index.js";
import type { GatewayModelConfig, GatewayModelPrice } from "./platform.js";

/**
 * What SelfBench knows of the models its gateway serves, for the API's gateway: a config for the
 * gateways' models Pi's catalog lacks, and every model's list price. Both read the gateway listings
 * the API keeps fresh (gateways/refresh.ts) and the catalog's reference rates.
 */

function parts(model: string): { provider: string; id: string } {
  const slash = model.indexOf("/");
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/**
 * A gateway's model as its listing describes it, when Pi's catalog, which the gateway reads first,
 * lacks it: its provider, native id, API, context window, output limit, thinking levels and price.
 */
export function listedModelConfig(model: string): GatewayModelConfig | undefined {
  const { provider, id } = parts(model);
  if (!isGateway(provider) || pi.getModel?.(provider, id)) return undefined;
  const listed = listedModel(provider, id);
  const price = gatewayModelPrice(model);
  if (!listed && !price) return undefined;
  const levels = listed?.thinking?.filter((level) => level !== "default");
  return {
    provider,
    native_model_id: id,
    // Gateways speak OpenAI Chat Completions to every vendor (as Pi reaches them).
    api: "openai-completions",
    ...(listed?.pi?.contextWindow ? { context_window: listed.pi.contextWindow } : {}),
    ...(listed?.pi?.maxTokens ? { max_output_tokens: listed.pi.maxTokens } : {}),
    ...(levels?.length ? { supported_thinking_levels: levels } : {}),
    cost: price ?? { input: 0, output: 0 },
  };
}

/**
 * The model's list price: a gateway's live one, or the catalog's reference rates on its vendor's
 * own key. Undefined for a model neither prices, such as a custom endpoint's.
 */
export function gatewayModelPrice(model: string): GatewayModelPrice | undefined {
  const { provider, id } = parts(model);
  const vendor = findModel(id);
  const pricing = isGateway(provider)
    ? gatewayPricing(provider, id)
    : vendor?.vendor === provider
      ? nativePricing(vendor)
      : undefined;
  return pricing && routerPrice(pricing);
}

/** Pricing as the gateway takes it: a tier prices a request whose prompt is above a size. */
function routerPrice(pricing: ModelPricing): GatewayModelPrice {
  return {
    input: pricing.input,
    output: pricing.output,
    cached_input: pricing.cacheRead,
    cache_write: pricing.cacheWrite,
    ...(pricing.longContext?.length
      ? {
          tiers: pricing.longContext.map((tier) => ({
            input_tokens_above: tier.from - 1,
            input: tier.input,
            output: tier.output,
            cached_input: tier.cacheRead,
            cache_write: tier.cacheWrite,
          })),
        }
      : {}),
  };
}
