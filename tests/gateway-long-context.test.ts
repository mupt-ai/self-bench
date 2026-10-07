import { expect, test } from "bun:test";
import type { ModelPricing } from "../src/contracts/models.js";
import { gateways } from "../src/gateways/index.js";
import { atVendorRates, vendorListRates } from "../src/gateways/vendor-pricing.js";

/** $ per million tokens as a gateway's per-token price string. */
const perToken = (rate: number) => String(rate / 1_000_000);

/** What a gateway's listing says `id` costs by prompt size. */
function listed(gateway: keyof typeof gateways, id: string, pricing: Record<string, unknown>) {
  return gateways[gateway].parse({ data: [{ id, pricing }] }, "2026-10-07").rates.get(id);
}

test("OpenRouter's prompt-size overrides become long-context tiers", () => {
  // Shaped like OpenRouter's listing of Haiku 5.5 on 2026-10-07.
  expect(
    listed("openrouter", "anthropic/claude-haiku-5.5", {
      prompt: perToken(0.1),
      completion: perToken(0.5),
      input_cache_read: perToken(0.01),
      input_cache_write: perToken(0.125),
      overrides: [
        {
          min_prompt_tokens: 100_000,
          prompt: perToken(0.5),
          completion: perToken(2.5),
          input_cache_read: perToken(0.05),
          input_cache_write: perToken(0.625),
          input_cache_write_1h: perToken(1),
        },
      ],
    }),
  ).toEqual({
    rates: [0.1, 0.5, 0.01, 0.125],
    asOf: "2026-10-07",
    longContext: [{ from: 100_001, rates: [0.5, 2.5, 0.05, 0.625] }],
  });
  // Two sizes, out of order, beside a time-of-day price that applies to every size.
  const tier = (min: number, input: number) => ({
    min_prompt_tokens: min,
    prompt: perToken(input),
    completion: perToken(input * 4),
  });
  expect(
    listed("openrouter", "qwen/qwen3.7-flash", {
      prompt: perToken(0.05),
      completion: perToken(0.2),
      overrides: [
        tier(256_000, 0.2),
        { utc_start: 0, utc_end: 800, prompt: "0" },
        tier(32_000, 0.1),
      ],
    })?.longContext,
  ).toEqual([
    { from: 32_001, rates: [0.1, 0.4, 0.1, 0.1] },
    { from: 256_001, rates: [0.2, 0.8, 0.2, 0.2] },
  ]);
  // A tier without the cache read price the base lists cannot price its prompts.
  expect(
    listed("openrouter", "vendor/partial", {
      prompt: perToken(1),
      completion: perToken(2),
      input_cache_read: perToken(0.1),
      overrides: [tier(64_000, 2), { ...tier(32_000, 1.5), input_cache_read: perToken(0.15) }],
    }),
  ).toMatchObject({
    longContext: [{ from: 32_001, rates: [1.5, 6, 0.15, 1.5] }],
    unpricedFrom: 64_001,
  });
});

test("Vercel's per-price tier lists combine into long-context tiers", () => {
  const tiers = (...prices: [number, number | undefined, number | undefined][]) =>
    prices.map(([cost, min, max]) => ({
      cost: perToken(cost),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    }));
  // Shaped like Vercel's listing of Haiku 5.5 on 2026-10-07.
  expect(
    listed("vercel-ai-gateway", "anthropic/claude-haiku-5.5", {
      input: perToken(0.1),
      output: perToken(0.5),
      input_cache_read: perToken(0.01),
      input_cache_write: perToken(0.125),
      input_tiers: tiers([0.1, 0, 100_001], [0.5, 100_001, undefined]),
      output_tiers: tiers([0.5, 0, 100_001], [2.5, 100_001, undefined]),
      input_cache_read_tiers: tiers([0.01, 0, 100_001], [0.05, 100_001, undefined]),
      input_cache_write_tiers: tiers([0.125, 0, 100_001], [0.625, 100_001, undefined]),
    })?.longContext,
  ).toEqual([{ from: 100_001, rates: [0.5, 2.5, 0.05, 0.625] }]);
  // A list that begins later charges its listed price until then; an unlisted cache write the
  // base lists is unknown once a tier begins.
  expect(
    listed("vercel-ai-gateway", "vendor/staggered", {
      input: perToken(1),
      output: perToken(2),
      input_cache_read: perToken(0.1),
      input_cache_write: perToken(1.25),
      input_tiers: tiers([1, 0, 32_001], [2, 32_001, 128_001], [3, 128_001, undefined]),
      output_tiers: tiers([2, 0, 32_001], [4, 32_001, undefined]),
      input_cache_read_tiers: tiers([0.3, 128_001, undefined]),
    }),
  ).toMatchObject({ unpricedFrom: 32_001 });
  expect(
    listed("vercel-ai-gateway", "vendor/staggered", {
      input: perToken(1),
      output: perToken(2),
      input_cache_read: perToken(0.1),
      input_tiers: tiers([1, 0, 32_001], [2, 32_001, 128_001], [3, 128_001, undefined]),
      output_tiers: tiers([2, 0, 32_001], [4, 32_001, undefined]),
      input_cache_read_tiers: tiers([0.3, 128_001, undefined]),
    })?.longContext,
  ).toEqual([
    { from: 32_001, rates: [2, 4, 0.1, 2] },
    { from: 128_001, rates: [3, 4, 0.3, 3] },
  ]);
});

test("vendor list rates carry the vendor's tiers, discount taken back; a route's limit stays", async () => {
  const fetcher = (async () =>
    Response.json({
      data: {
        endpoints: [
          {
            tag: "anthropic",
            pricing: {
              prompt: perToken(0.05),
              completion: perToken(0.25),
              input_cache_read: perToken(0.005),
              input_cache_write: perToken(0.0625),
              discount: 0.5,
              overrides: [
                {
                  min_prompt_tokens: 100_000,
                  prompt: perToken(0.25),
                  completion: perToken(1.25),
                  input_cache_read: perToken(0.025),
                  input_cache_write: perToken(0.3125),
                },
              ],
            },
          },
        ],
      },
    })) as unknown as typeof fetch;
  const vendor = await vendorListRates("anthropic/claude-haiku-5.5", fetcher);
  expect(vendor).toEqual({
    rates: [0.1, 0.5, 0.01, 0.125],
    source: "https://openrouter.ai/anthropic/claude-haiku-5.5/providers",
    longContext: [{ from: 100_001, rates: [0.5, 2.5, 0.05, 0.625] }],
  });
  const route: ModelPricing = {
    ...{ input: 0.08, output: 0.4, cacheRead: 0.008, cacheWrite: 0.1 },
    longContext: [{ from: 100_001, input: 0.4, output: 2, cacheRead: 0.04, cacheWrite: 0.5 }],
    ...{ source: "https://vercel.com/ai-gateway/models/claude-haiku-5.5", asOf: "2026-10-07" },
  };
  if (!vendor) throw new Error("Missing vendor rates");
  expect(atVendorRates(route, vendor, "2026-10-07")).toEqual({
    ...{ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    longContext: [{ from: 100_001, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    ...{ source: vendor.source, asOf: "2026-10-07" },
  });
  // Without the vendor's tiers, its rates price only the prompts the route's base rates did.
  expect(
    atVendorRates(route, { rates: vendor.rates, source: vendor.source }, "2026-10-07"),
  ).toEqual({
    ...{ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    maxInputTokens: 100_000,
    ...{ source: vendor.source, asOf: "2026-10-07" },
  });
});
