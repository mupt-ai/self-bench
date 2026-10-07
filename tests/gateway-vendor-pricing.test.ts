import { expect, test } from "bun:test";
import type { ModelPricing } from "../src/contracts/models.js";
import { type CatalogModel, runPricing } from "../src/evaluation/catalog.js";
import { vendorListRates } from "../src/gateways/vendor-pricing.js";

const perToken = (rate: number) => String(rate / 1_000_000);
const endpoint = (tag: string, [input, output, cacheRead]: number[], discount = 0) => ({
  tag,
  pricing: {
    prompt: perToken(input ?? 0),
    completion: perToken(output ?? 0),
    input_cache_read: perToken(cacheRead ?? 0),
    discount,
  },
});
// Shaped like OpenRouter's /models/<id>/endpoints on 2026-10-06.
const listings: Record<string, unknown[]> = {
  "mistralai/mistral-large-4-0": [
    endpoint("deepinfra/fp4", [0.5, 1.5, 0.05]),
    endpoint("mistral", [0.68, 2.09, 0.07], 0.5),
  ],
  "qwen/qwen3.8-27b": [
    endpoint("alibaba/flex", [0.2, 1.2, 0.04]),
    endpoint("alibaba", [0.425, 2.55, 0.085]),
  ],
  "moonshotai/kimi-k3": [endpoint("moonshotai/mxfp4", [3, 15, 0.3])],
  "z-ai/glm-5.3": [endpoint("fireworks", [1.4, 4.4, 0.26])],
};
const openRouter = (async (url: string) => {
  const id = /\/models\/(.+)\/endpoints$/.exec(url)?.[1] ?? "";
  if (id === "x-ai/down") throw new Error("network down");
  const endpoints = listings[id];
  return endpoints ? Response.json({ data: { endpoints } }) : new Response(null, { status: 404 });
}) as unknown as typeof fetch;

test("vendor list rates come from the vendor's own endpoint with its discount taken back", async () => {
  expect(await vendorListRates("mistralai/mistral-large-4-0", openRouter)).toEqual({
    rates: [1.36, 4.18, 0.14, 1.36],
    source: "https://openrouter.ai/mistralai/mistral-large-4-0/providers",
  });
  // A vendor serving under another slug, its plain endpoint over a cheaper tier.
  expect((await vendorListRates("qwen/qwen3.8-27b", openRouter))?.rates).toEqual([
    0.425, 2.55, 0.085, 0.425,
  ]);
  // A vendor listing only a variant of its endpoint.
  expect((await vendorListRates("moonshotai/kimi-k3", openRouter))?.rates).toEqual([3, 15, 0.3, 3]);
  // Only other providers, an unlisted model, or no answer: no vendor rates.
  for (const id of ["z-ai/glm-5.3", "mistralai/unknown", "x-ai/down", "custom-model"])
    expect(await vendorListRates(id, openRouter)).toBeUndefined();
});

test("gateway runs take vendor list rates and keep their bound; other routes keep theirs", async () => {
  const listed: ModelPricing = {
    input: 0.68,
    output: 2.09,
    cacheRead: 0.07,
    cacheWrite: 0.68,
    maxInputTokens: 199_999,
    source: "https://vercel.com/ai-gateway/models/mistral-large-4",
    asOf: "2026-10-06",
  };
  const model: CatalogModel = {
    id: "mistralai/mistral-large-4-0",
    provider: "openrouter",
    model: "mistralai/mistral-large-4-0",
    label: "Mistral Large 4",
    harnesses: ["pi"],
    source: "",
    gateways: { "vercel-ai-gateway": "mistral/mistral-large-4" },
  };
  const vercel = {
    ...model,
    provider: "vercel-ai-gateway" as const,
    model: "mistral/mistral-large-4",
    pricing: listed,
  };
  expect(await runPricing(model, vercel, openRouter)).toMatchObject({
    input: 1.36,
    output: 4.18,
    cacheRead: 0.14,
    cacheWrite: 1.36,
    maxInputTokens: 199_999,
    source: "https://openrouter.ai/mistralai/mistral-large-4-0/providers",
  });
  const unlisted = { ...model, id: "mistralai/unknown" };
  expect(await runPricing(unlisted, vercel, openRouter)).toEqual(listed);
  const unreachable = (async () => {
    throw new Error("native routes never ask OpenRouter");
  }) as unknown as typeof fetch;
  const native = { ...vercel, provider: "anthropic" as const };
  expect(await runPricing(model, native, unreachable)).toEqual(listed);
});
