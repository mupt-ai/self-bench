import { expect, test } from "bun:test";
import { billedTrialCost, gatewayCost } from "../src/evaluation/gateway-cost.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import { generationIds } from "../src/gateways/usage.js";
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

test("OpenRouter retries delayed generations but never accepts a routed leaf subtotal without billing access", async () => {
  let attempts = 0;
  let waitMs = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    waitMs += delay ?? 0;
    queueMicrotask(() => callback(...args));
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const delayed = (async () => {
    attempts += 1;
    return attempts < 3
      ? Response.json({ error: { message: "Generation not found" } }, { status: 404 })
      : Response.json({
          data: {
            router: "example/router",
            model: "openai/gpt-6-luna",
            total_cost: 0,
            upstream_inference_cost: 0.0000039,
            is_byok: true,
          },
        });
  }) as unknown as typeof fetch;
  try {
    const single = new Map([
      [
        "solver/trial/agent/pi.txt",
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", responseId: "gen-1791843781-routertest" },
        }),
      ],
    ]);
    expect(await gatewayCost("openrouter", "key", "pi", single, delayed)).toBeUndefined();
    expect(attempts).toBe(3);
    expect(waitMs).toBe(10_000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("OpenRouter zero-token billing placeholders cannot price token-bearing replies as free", async () => {
  const message = {
    role: "assistant",
    responseId: "gen-1791855534-NslUwCGGykHhJuQnwkrz",
    usage: { input: 3, output: 80, cacheRead: 12000, cacheWrite: 200 },
  };
  const placeholder = (async () =>
    Response.json({
      data: {
        router: "example/router",
        total_cost: 0,
        upstream_inference_cost: 0,
        is_byok: false,
        native_tokens_prompt: 0,
        native_tokens_completion: 0,
      },
    })) as unknown as typeof fetch;
  for (const usage of [message.usage, { cacheRead: 12000 }, { cacheWrite: 200 }]) {
    const reply = { ...message, usage };
    for (const text of [
      JSON.stringify({ type: "message_end", message: reply }),
      `[Earlier output truncated]\n${JSON.stringify({
        type: "agent_end",
        messages: [{ role: "user" }, reply],
      })}\n`,
    ]) {
      const measured = new Map([["agent/pi.txt", text]]);
      expect(await gatewayCost("openrouter", "key", "pi", measured, placeholder)).toBeUndefined();
    }
  }
});

test("one contradictory zero-token bill prevents publishing a partial trial bill", async () => {
  const measured = new Map([
    [
      "agent/pi.txt",
      [...files.values()][0] +
        "\n" +
        JSON.stringify({
          type: "agent_end",
          messages: [
            { role: "user" },
            {
              role: "assistant",
              responseId: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAX",
              usage: { output: 100 },
            },
          ],
        }),
    ],
  ]);
  const partial = (async (url: string) =>
    Response.json({
      data: url.endsWith("FAV")
        ? { total_cost: 0.12 }
        : { total_cost: 0, native_tokens_prompt: 0, native_tokens_completion: 0 },
    })) as unknown as typeof fetch;
  expect(await gatewayCost("openrouter", "key", "pi", measured, partial)).toBeUndefined();
});

test("explicitly free token-bearing generations and empty replies still cost zero", async () => {
  const measured = (usage: Record<string, number>) =>
    new Map([
      [
        "agent/pi.txt",
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", responseId: "gen-free-model", usage },
        }),
      ],
    ]);
  const free = (async () =>
    Response.json({
      data: { total_cost: 0, native_tokens_prompt: 10, native_tokens_completion: 5 },
    })) as unknown as typeof fetch;
  expect(
    await gatewayCost("openrouter", "key", "pi", measured({ input: 10, output: 5 }), free),
  ).toBe(0);
  const empty = (async () =>
    Response.json({
      data: { total_cost: 0, native_tokens_prompt: 0, native_tokens_completion: 0 },
    })) as unknown as typeof fetch;
  expect(
    await gatewayCost("openrouter", "key", "pi", measured({ input: 0, output: 0 }), empty),
  ).toBe(0);
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
