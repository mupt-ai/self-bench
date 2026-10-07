import { baseRatesLimit, type ModelPricing } from "../contracts/models.js";
import { HOUR_CACHE_WRITE_MULTIPLIER } from "../harnesses/claude-code/cost.js";
import type { TokenUsage } from "./types.js";

/** One request's token buckets, with `hourCacheWrite` of its cache writes kept for an hour. */
export type RequestUsage = TokenUsage & { readonly hourCacheWrite?: number };

export function sumUsage(requests: readonly TokenUsage[]): TokenUsage {
  const sum: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const request of requests) {
    sum.input += request.input;
    sum.output += request.output;
    sum.cacheRead += request.cacheRead;
    sum.cacheWrite += request.cacheWrite;
  }
  return sum;
}

export const sameUsage = (left: TokenUsage, right: TokenUsage) =>
  left.input === right.input &&
  left.output === right.output &&
  left.cacheRead === right.cacheRead &&
  left.cacheWrite === right.cacheWrite;

type RatesOf = Pick<ModelPricing, "input" | "output" | "cacheRead" | "cacheWrite">;

/** `usage` at `rates`, with `hourCacheWrite` of its cache writes kept for an hour. */
export function referenceCost(rates: RatesOf, usage: TokenUsage, hourCacheWrite = 0) {
  return (
    (usage.input * rates.input +
      usage.output * rates.output +
      usage.cacheRead * rates.cacheRead +
      (usage.cacheWrite - hourCacheWrite) * rates.cacheWrite +
      hourCacheWrite * rates.input * HOUR_CACHE_WRITE_MULTIPLIER) /
    1_000_000
  );
}

/** The rates `pricing` bills a request with a `prompt`-token prompt at; none past its limit. */
function ratesFor(pricing: ModelPricing, prompt: number): RatesOf | undefined {
  if (pricing.maxInputTokens !== undefined && prompt > pricing.maxInputTokens) return undefined;
  return pricing.longContext?.filter((tier) => prompt >= tier.from).at(-1) ?? pricing;
}

/**
 * `requests` at the reference rates, each at the tier its prompt reaches; undefined when one is
 * past what the rates price. Requests at the same rates are summed first, so a trial within one
 * tier costs exactly what its totals do.
 */
export function requestsCost(
  pricing: ModelPricing,
  requests: readonly RequestUsage[],
): number | undefined {
  const tiers = new Map<RatesOf, { usage: TokenUsage[]; hourCacheWrite: number }>();
  for (const request of requests) {
    const rates = ratesFor(pricing, request.input + request.cacheRead + request.cacheWrite);
    if (!rates) return undefined;
    const tier = tiers.get(rates) ?? { usage: [], hourCacheWrite: 0 };
    tier.usage.push(request);
    tier.hourCacheWrite += request.hourCacheWrite ?? 0;
    tiers.set(rates, tier);
  }
  let cost = 0;
  for (const [rates, tier] of tiers)
    cost += referenceCost(rates, sumUsage(tier.usage), tier.hourCacheWrite);
  return cost;
}

/**
 * `usage` priced whole, for records that do not give every request: its largest known prompt,
 * else its total standing in for one, must be within the base rates, which then price it all.
 */
export function wholeCost(
  pricing: ModelPricing,
  usage: TokenUsage,
  largestPrompt: number | undefined,
  hourCacheWrite: number,
): number | undefined {
  const prompt = largestPrompt ?? usage.input + usage.cacheRead + usage.cacheWrite;
  const limit = baseRatesLimit(pricing);
  return limit === undefined || prompt < limit
    ? referenceCost(pricing, usage, hourCacheWrite)
    : undefined;
}
