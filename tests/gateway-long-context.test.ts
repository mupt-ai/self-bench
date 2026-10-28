import { afterEach, expect, test } from "bun:test";
import { refreshGateway } from "../src/gateways/catalog.js";
import {
  type GatewayId,
  gatewayIds,
  gatewayPricing,
  setGatewayListing,
} from "../src/gateways/index.js";

afterEach(() => {
  for (const gateway of gatewayIds) setGatewayListing(gateway, { models: [], rates: new Map() });
});

/** $ per million tokens as a gateway's per-token price string. */
const perToken = (rate: number) => (rate / 1_000_000).toFixed(12);

/** What the gateway's catalog says `id` costs by prompt size, as SelfBench prices it. */
async function listed(gateway: GatewayId, id: string, pricing: Record<string, unknown>) {
  const entry = {
    id,
    type: "language",
    supported_parameters: ["tools"],
    architecture: { output_modalities: ["text"] },
    modalities: { output: ["text"] },
    pricing,
  };
  await refreshGateway(gateway, (async () => Response.json({ data: [entry] })) as never);
  return gatewayPricing(gateway, id);
}

test("OpenRouter's prompt-size overrides become long-context tiers", async () => {
  // Shaped like OpenRouter's listing of Haiku 5.5 on 2026-10-07.
  expect(
    await listed("openrouter", "anthropic/claude-haiku-5.5", {
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
        },
      ],
    }),
  ).toMatchObject({
    ...{ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    longContext: [{ from: 100_001, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
  });
  // A tier without the cache read price the base lists cannot price its prompts.
  const tier = (min: number, input: number) => ({
    min_prompt_tokens: min,
    prompt: perToken(input),
    completion: perToken(input * 4),
  });
  expect(
    await listed("openrouter", "vendor/partial", {
      prompt: perToken(1),
      completion: perToken(2),
      input_cache_read: perToken(0.1),
      overrides: [tier(64_000, 2), { ...tier(32_000, 1.5), input_cache_read: perToken(0.15) }],
    }),
  ).toMatchObject({
    longContext: [{ from: 32_001, input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.5 }],
    maxInputTokens: 64_000,
  });
});

test("Vercel's per-price tier lists combine into long-context tiers", async () => {
  const tiers = (...prices: [number, number, number | undefined][]) =>
    prices.map(([cost, min, max]) => ({
      cost: perToken(cost),
      min,
      ...(max === undefined ? {} : { max }),
    }));
  // Shaped like Vercel's listing of Haiku 5.5 on 2026-10-07.
  expect(
    (
      await listed("vercel-ai-gateway", "anthropic/claude-haiku-5.5", {
        input: perToken(0.1),
        output: perToken(0.5),
        input_cache_read: perToken(0.01),
        input_cache_write: perToken(0.125),
        input_tiers: tiers([0.1, 0, 100_001], [0.5, 100_001, undefined]),
        output_tiers: tiers([0.5, 0, 100_001], [2.5, 100_001, undefined]),
        input_cache_read_tiers: tiers([0.01, 0, 100_001], [0.05, 100_001, undefined]),
        input_cache_write_tiers: tiers([0.125, 0, 100_001], [0.625, 100_001, undefined]),
      })
    )?.longContext,
  ).toEqual([{ from: 100_001, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }]);
});
