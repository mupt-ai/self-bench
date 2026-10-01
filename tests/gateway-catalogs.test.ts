import { afterEach, expect, test } from "bun:test";
import { findModel, nativePricing } from "../src/contracts/models.js";
import {
  catalogModelId,
  type GatewayId,
  gatewayIds,
  gatewayModelId,
  gatewayPricing,
  listedModels,
  setGatewayListing,
} from "../src/gateways/index.js";
import { refreshGateway } from "../src/gateways/refresh.js";

afterEach(() => {
  for (const gateway of gatewayIds) setGatewayListing(gateway, { models: [], rates: new Map() });
});

const respond = (data: unknown[], status = 200) =>
  (async () => Response.json({ data }, { status })) as unknown as typeof fetch;

function sol() {
  const model = findModel("gpt-6-sol");
  if (!model) throw new Error("Missing Sol");
  return model;
}

/** Sol's price through `gateway`, as generation and evaluation read it. */
const solPricing = (gateway: GatewayId) =>
  gatewayPricing(gateway, gatewayModelId(gateway, sol().openRouter), sol().rates?.gateway);

test("OpenRouter pricing comes from the models API, native pricing stays in the catalog", async () => {
  await refreshGateway(
    "openrouter",
    respond([
      {
        id: "openai/gpt-6-sol",
        pricing: {
          prompt: "0.000003",
          completion: "0.000015",
          input_cache_read: "0.0000003",
          input_cache_write: "0.00000375",
        },
      },
      { id: "moonshotai/kimi-k3", pricing: { prompt: "0.000003", completion: "0.000015" } },
      { id: "not/in-catalog", pricing: { prompt: "1", completion: "1" } },
    ]),
  );
  expect(solPricing("openrouter")).toMatchObject({
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    source: "https://openrouter.ai/openai/gpt-6-sol",
    asOf: new Date().toISOString().slice(0, 10),
  });
  expect(nativePricing(sol())).toMatchObject({ input: 2, output: 10 });
  expect(gatewayPricing("openrouter", "moonshotai/kimi-k3")).toMatchObject({
    cacheRead: 3,
    cacheWrite: 3,
  });
  // Each gateway keeps its own prices: Vercel's are still the catalog's reference rates.
  expect(solPricing("vercel-ai-gateway")).toMatchObject({ input: 2, asOf: "2026-09-23" });
});

test("models a gateway does not price keep the catalog's reference rates", async () => {
  await refreshGateway(
    "openrouter",
    respond([
      { id: "openai/gpt-6-sol", pricing: { prompt: "-1", completion: "0.00001" } },
      { id: "openai/gpt-6-luna", pricing: { prompt: "0.0000001", completion: "0.0000005" } },
    ]),
  );
  expect(solPricing("openrouter")).toMatchObject({ input: 2, asOf: "2026-09-23" });
});

test("a failed or empty refresh keeps the last good rates", async () => {
  await expect(refreshGateway("openrouter", respond([], 503))).rejects.toThrow(/503/);
  await expect(refreshGateway("vercel-ai-gateway", respond([]))).rejects.toThrow(
    /Vercel AI Gateway returned no prices/,
  );
  expect(solPricing("openrouter")).toMatchObject({ input: 2, output: 10 });
});

test("OpenRouter lists agent-capable models frontier first, then by popularity", async () => {
  let url = "";
  const agent = (id: string, extra: object = {}) => ({
    id,
    name: `Vendor: Name of ${id}`,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    supported_parameters: ["tools", "reasoning"],
    ...extra,
  });
  const scored = (index: number) => ({
    benchmarks: { artificial_analysis: { intelligence_index: index } },
  });
  await refreshGateway("openrouter", (async (input: string) => {
    url = input;
    return Response.json({
      data: [
        agent("z-ai/glm-5.3-flash", { reasoning: { supported_efforts: ["max", "none", "low"] } }),
        agent("vendor/retiring", { expiration_date: "2026-10-15" }),
        agent("vendor/any-effort", { reasoning: { supported_efforts: null }, ...scored(40) }),
        agent("vendor/no-tools", { supported_parameters: ["reasoning"] }),
        agent("vendor/images", { architecture: { output_modalities: ["image"] } }),
        agent("vendor/model:free"),
        agent("openrouter/auto"),
        agent("vendor/varies", { pricing: { prompt: "-1", completion: "0.000002" } }),
        agent("moonshotai/kimi-k3", { name: "", ...scored(43.6) }),
        agent("vendor/unscored"),
      ],
    });
  }) as unknown as typeof fetch);
  expect(url).toEndWith("/api/v1/models?sort=most-popular");
  expect(listedModels("openrouter")).toEqual([
    { id: "moonshotai/kimi-k3", label: "moonshotai/kimi-k3" },
    {
      id: "vendor/any-effort",
      label: "Name of vendor/any-effort",
      thinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "z-ai/glm-5.3-flash",
      label: "Name of z-ai/glm-5.3-flash",
      thinking: ["off", "low", "max"],
    },
    { id: "vendor/unscored", label: "Name of vendor/unscored" },
  ]);
  await expect(refreshGateway("openrouter", respond([], 503))).rejects.toThrow(/503/);
  expect(listedModels("openrouter")).toHaveLength(4);
});

test("Vercel AI Gateway lists agent-capable language models newest first, at its prices", async () => {
  let url = "";
  const language = (id: string, released: number, extra: object = {}) => ({
    id,
    name: `Name of ${id}`,
    type: "language",
    released,
    tags: ["tool-use", "reasoning"],
    modalities: { input: ["text", "image"], output: ["text"] },
    pricing: { input: "0.0000014", output: "0.0000044", input_cache_read: "0.00000014" },
    ...extra,
  });
  await refreshGateway("vercel-ai-gateway", (async (input: string) => {
    url = input;
    return Response.json({
      data: [
        language("zai/glm-5.3", 2, {
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        }),
        language("vendor/toggle-only", 3, { reasoning_options: [{ type: "toggle" }] }),
        language("vendor/newest", 4, {
          reasoning_options: [
            { type: "toggle" },
            { type: "effort", values: ["none", "low", "medium", "high"] },
          ],
        }),
        language("vendor/no-tools", 5, { tags: ["reasoning"] }),
        language("vendor/retiring", 5, { deprecated_at: 1803600000000 }),
        language("vendor/embedding", 5, { type: "embedding" }),
        language("vendor/image-out", 5, { modalities: { input: ["text"], output: ["image"] } }),
        language("vendor/unpriced", 5, { pricing: {} }),
      ],
    });
  }) as unknown as typeof fetch);
  expect(url).toBe("https://ai-gateway.vercel.sh/v1/models");
  expect(listedModels("vercel-ai-gateway")).toEqual([
    {
      id: "vendor/newest",
      label: "Name of vendor/newest",
      thinking: ["off", "low", "medium", "high"],
    },
    { id: "vendor/toggle-only", label: "Name of vendor/toggle-only" },
    { id: "zai/glm-5.3", label: "Name of zai/glm-5.3", thinking: ["low", "high", "max"] },
  ]);
  // Cache writes fall back to the input price; the curated GLM takes Vercel's spelling and price.
  const glm = findModel("glm-5.3");
  if (!glm) throw new Error("Missing GLM");
  expect(
    gatewayPricing("vercel-ai-gateway", gatewayModelId("vercel-ai-gateway", glm.openRouter)),
  ).toMatchObject({
    input: 1.4,
    output: 4.4,
    cacheRead: 0.14,
    cacheWrite: 1.4,
    source: "https://vercel.com/ai-gateway/models/glm-5.3",
  });
});

test("gateways spell some vendors their own way; the catalog spells them as OpenRouter does", () => {
  expect(gatewayModelId("vercel-ai-gateway", "z-ai/glm-5.3")).toBe("zai/glm-5.3");
  expect(catalogModelId("vercel-ai-gateway", "zai/glm-5.3")).toBe("z-ai/glm-5.3");
  expect(catalogModelId("vercel-ai-gateway", "spacexai/grok-4.7")).toBe("x-ai/grok-4.7");
  expect(catalogModelId("vercel-ai-gateway", "anthropic/claude-sonnet-5")).toBe(
    "anthropic/claude-sonnet-5",
  );
});
