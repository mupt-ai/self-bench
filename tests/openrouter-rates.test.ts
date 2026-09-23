import { afterEach, expect, test } from "bun:test";
import { findModel, modelPricing, setOpenRouterRates } from "../src/contracts/models.js";
import { refreshOpenRouterRates } from "../src/lib/openrouter-rates.js";

afterEach(() => setOpenRouterRates(new Map()));

const respond = (data: unknown[], status = 200) =>
  (async () => Response.json({ data }, { status })) as unknown as typeof fetch;

function sol() {
  const model = findModel("gpt-6-sol");
  if (!model) throw new Error("Missing Sol");
  return model;
}

test("OpenRouter pricing comes from the models API, native pricing stays in the catalog", async () => {
  await refreshOpenRouterRates(
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
  expect(modelPricing(sol(), "openRouter")).toMatchObject({
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    asOf: new Date().toISOString().slice(0, 10),
  });
  expect(modelPricing(sol(), "native")).toMatchObject({ input: 2, output: 10 });
  const kimi = findModel("kimi-k3");
  if (!kimi) throw new Error("Missing Kimi");
  expect(modelPricing(kimi, "openRouter")).toMatchObject({ cacheRead: 3, cacheWrite: 3 });
});

test("models OpenRouter does not price keep the catalog's reference rates", async () => {
  await refreshOpenRouterRates(
    respond([
      { id: "openai/gpt-6-sol", pricing: { prompt: "-1", completion: "0.00001" } },
      { id: "openai/gpt-6-luna", pricing: { prompt: "0.0000001", completion: "0.0000005" } },
    ]),
  );
  expect(modelPricing(sol(), "openRouter")).toMatchObject({ input: 2, asOf: "2026-09-23" });
});

test("a failed or empty refresh keeps the last good rates", async () => {
  await expect(refreshOpenRouterRates(respond([], 503))).rejects.toThrow(/503/);
  await expect(refreshOpenRouterRates(respond([]))).rejects.toThrow(/no prices/);
  expect(modelPricing(sol(), "openRouter")).toMatchObject({ input: 2, output: 10 });
});
