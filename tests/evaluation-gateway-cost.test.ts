import { expect, test } from "bun:test";
import { billedTrialCost, gatewayCost, generationIds } from "../src/evaluation/gateway-cost.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const files = new Map([
  [
    "solver/trial/agent/pi.txt",
    ["gen_01ARZ3NDEKTSV4RRFFQ69G5FAV", "gen_01ARZ3NDEKTSV4RRFFQ69G5FAX"]
      .map((responseId) =>
        JSON.stringify({ type: "message_end", message: { role: "assistant", responseId } }),
      )
      .join("\n"),
  ],
]);

test("gateway trials sum charged generations rather than Pi's reference-rate costs", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return Response.json({ data: { total_cost: url.endsWith("FAV") ? 0.12 : 0.34 } });
  }) as typeof fetch;
  expect(await gatewayCost("vercel-ai-gateway", "key", "pi", files, fetcher)).toBeCloseTo(0.46);
  expect(urls).toEqual([
    "https://ai-gateway.vercel.sh/v1/generation?id=gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "https://ai-gateway.vercel.sh/v1/generation?id=gen_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  ]);
  urls.length = 0;
  expect(await gatewayCost("openrouter", "key", "pi", files, fetcher)).toBeCloseTo(0.46);
  expect(urls[0]).toStartWith("https://openrouter.ai/api/v1/generation?id=");
});

test("BYOK generations count the provider's charge, which the gateway leaves out of total_cost", async () => {
  // As OpenRouter reported a Fireworks BYOK glm-5.3 request on 2026-09-30.
  const fetcher = (async (url: string) =>
    Response.json({
      data: url.endsWith("FAV")
        ? { total_cost: 0, upstream_inference_cost: 0.02228638, is_byok: true }
        : { total_cost: 0.022165855, upstream_inference_cost: 0, is_byok: false },
    })) as unknown as typeof fetch;
  for (const gateway of ["openrouter", "vercel-ai-gateway"] as const)
    expect(await gatewayCost(gateway, "key", "pi", files, fetcher)).toBeCloseTo(
      0.02228638 + 0.022165855,
    );
  const unbilled = (async () =>
    Response.json({ data: { total_cost: 0, is_byok: true } })) as unknown as typeof fetch;
  expect(await gatewayCost("vercel-ai-gateway", "key", "pi", files, unbilled)).toBeUndefined();
});

test("missing bills and unsupported harnesses leave the caller's usage estimate untouched", async () => {
  const missing = (async () => Response.json({ data: {} })) as unknown as typeof fetch;
  expect(await gatewayCost("openrouter", "key", "pi", files, missing)).toBeUndefined();
  expect(await gatewayCost("openrouter", "key", "codex", files, missing)).toBeUndefined();
  const partial = new Map([
    ["agent/pi.txt", `${files.values().next().value}\n{"type":"message_end","message":`],
  ]);
  expect(await gatewayCost("openrouter", "key", "pi", partial, missing)).toBeUndefined();
  const tail = new Map([
    [
      "agent/pi.txt",
      `[Earlier output truncated]\n${JSON.stringify({ type: "agent_end", messages: [{ role: "user" }, { role: "assistant", responseId: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV" }] })}\n`,
    ],
  ]);
  expect(generationIds("pi", tail)).toEqual(["gen_01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
});

test("a gateway's charge is kept beside the shown cost, and stands in only for a missing one", async () => {
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      modelName: "vercel-ai-gateway/mistral/mistral-large-4",
      credentials: {
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
        provider: "vercel-ai-gateway",
      },
    },
    "Mistral Large 4",
  );
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  const env = { AI_GATEWAY_API_KEY: "key" };
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ data: { total_cost: 0.25 } })) as unknown as typeof fetch;
  try {
    const priced = { ...trial, harness: "pi" as const, modelVerified: true, apiCostUsd: 1 };
    expect(await billedTrialCost(run, priced, env, files)).toEqual({ billedCostUsd: 0.5 });
    const { apiCostUsd: _cost, ...unpriced } = priced;
    expect(await billedTrialCost(run, unpriced, env, files)).toEqual({
      billedCostUsd: 0.5,
      apiCostUsd: 0.5,
      costSource: "gateway",
    });
  } finally {
    globalThis.fetch = original;
  }
});
