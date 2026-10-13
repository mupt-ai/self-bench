import { expect, test } from "bun:test";
import { trialCost } from "../src/evaluation/cost.js";
import { billedTrialCost, gatewayCost } from "../src/evaluation/gateway-cost.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import {
  OPENROUTER_BILLING,
  OPENROUTER_GENERATIONS,
  openRouterManifest,
} from "../src/gateways/openrouter/billing.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const root = {
  model: "worker-model",
  id: "gen-root",
  request_id: "req-root",
  session_id: "session-trial",
  router: "example/router",
  created_at: "2026-01-01T00:00:00Z",
  total_cost: 0,
  upstream_inference_cost: 0,
  is_byok: false,
  native_tokens_prompt: 0,
  native_tokens_completion: 0,
  upstream_id: null,
  provider_responses: [],
};
function child(id = "gen-child", cost = 0.2) {
  return {
    ...root,
    id,
    router: null,
    model: id === "gen-advisor" ? "advisor-model" : "worker-model",
    total_cost: 0.01,
    upstream_inference_cost: cost,
    is_byok: true,
    native_tokens_prompt: 10,
    native_tokens_completion: 5,
    upstream_id: `provider-${id}`,
    provider_responses: [{ id: `provider-${id}`, status: 200 }],
  };
}
const files = (prompt = 10, completion = 5) =>
  new Map([
    [
      "agent/pi.txt",
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          responseId: root.id,
          provider: "openrouter",
          model: "example/router",
          usage: { input: prompt, output: completion, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    ],
  ]);
function ledger(
  generations: Record<string, unknown>[],
  change?: (query: number) => Record<string, unknown>[],
) {
  let queries = 0;
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/analytics/query")) {
      const rows = (change?.(++queries) ?? generations).map((row) => ({
        generation_id: row.id,
        session_id: row.session_id,
      }));
      return Response.json({
        data: { data: rows, metadata: { row_count: rows.length, truncated: false } },
      });
    }
    const row = generations.find((row) => row.id === new URL(url).searchParams.get("id"));
    return row ? Response.json({ data: row }) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { requests, fetcher };
}
const noWait = async () => {};
async function price(
  generations: Record<string, unknown>[],
  change?: (query: number) => Record<string, unknown>[],
) {
  const { fetcher } = ledger(generations, change);
  const measured = files();
  return gatewayCost(
    "openrouter",
    "inference",
    "pi",
    measured,
    fetcher,
    "owner-management",
    noWait,
  );
}

test("OpenRouter zero wrappers resolve to exact nested BYOK charges, not rounded analytics prices", async () => {
  const input = files();
  const { fetcher, requests } = ledger([root, child("gen-child", 0.12345678)]);
  expect(
    await gatewayCost("openrouter", "inference", "pi", input, fetcher, "owner-management", noWait),
  ).toBeCloseTo(0.13345678, 10);
  const bill = JSON.parse(input.get(OPENROUTER_BILLING) ?? "{}");
  expect(bill.generations).toHaveLength(2);
  const queries = requests.filter((entry) => entry.url.endsWith("/analytics/query"));
  expect(queries).toHaveLength(2);
  expect(queries[0]?.init?.redirect).toBe("error");
  expect(queries[0]?.init?.headers).toMatchObject({ Authorization: "Bearer owner-management" });
  expect(JSON.parse(String(queries[0]?.init?.body)).filters).toEqual([
    { field: "session_id", operator: "in", value: ["session-trial"] },
  ]);
  expect(
    requests
      .filter((entry) => !entry.url.endsWith("/analytics/query"))
      .every(
        (entry) => new Headers(entry.init?.headers).get("Authorization") === "Bearer inference",
      ),
  ).toBe(true);
});

test("Routed groups of any size and any selected model reconcile", async () => {
  for (const router of ["example/router", "another/selector"]) {
    for (const count of [1, 2, 3, 7]) {
      const leaves = Array.from({ length: count }, (_, index) => ({
        ...child(`gen-leaf-${index}`),
        model: `provider/model-${index}`,
      }));
      expect(await price([{ ...root, router }, ...leaves])).toBeCloseTo(count * 0.21);
    }
  }
  const direct = { ...child(root.id), router: root.router };
  expect(await price([direct])).toBeCloseTo(0.21);
  const credit = { ...child(), is_byok: false, total_cost: 0.25, upstream_inference_cost: 999 };
  expect(await price([root, credit])).toBeCloseTo(0.25);
});

test("direct OpenRouter bills need no management key and do not add non-BYOK upstream costs", async () => {
  const direct = {
    ...child(root.id),
    router: null,
    is_byok: false,
    total_cost: 0.25,
    upstream_inference_cost: 999,
  };
  const { fetcher, requests } = ledger([direct]);
  const input = files();
  expect(
    await gatewayCost("openrouter", "inference", "pi", input, fetcher, undefined, noWait),
  ).toBe(0.25);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(input.get(OPENROUTER_BILLING) ?? "{}")).toMatchObject({
    cost: 0.25,
    creditsCost: 0.25,
    byokCost: 0,
  });
});

test("actual OpenRouter bills replace catalog estimates for ordinary models", async () => {
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      modelName: "openrouter/vendor/model",
      credentials: {
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
        provider: "openrouter",
      },
    },
    "Model",
  );
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  const original = globalThis.fetch;
  globalThis.fetch = ledger([{ ...child(root.id), router: null }]).fetcher;
  try {
    expect(
      await billedTrialCost(
        run,
        { ...trial, modelVerified: true, harness: "pi", apiCostUsd: 5 },
        { OPENROUTER_API_KEY: "key" },
        files(),
      ),
    ).toEqual({ apiCostUsd: 0.2 + 0.01, billedCostUsd: 0.2 + 0.01, costSource: "gateway" });
  } finally {
    globalThis.fetch = original;
  }
});

test("mixed routed and direct requests must all appear in the session ledger", async () => {
  const direct = { ...child("gen-direct"), request_id: "req-direct" };
  const input = files();
  input.set(
    "agent/pi.txt",
    `${input.get("agent/pi.txt")}\n${JSON.stringify({ type: "message_end", message: { role: "assistant", responseId: direct.id } })}`,
  );
  const { fetcher } = ledger([root, child(), direct]);
  expect(
    await gatewayCost("openrouter", "key", "pi", input, fetcher, "management", noWait),
  ).toBeCloseTo(0.42);
  const missing = ledger([root, child(), direct], () => [root, child()]);
  expect(
    await gatewayCost("openrouter", "key", "pi", input, missing.fetcher, "management", noWait),
  ).toBeUndefined();
  expect(input.has(OPENROUTER_BILLING)).toBe(false);
});

test("unlinked, missing and ambiguous OpenRouter accounting cannot yield partial totals", async () => {
  const cases = [
    [root],
    [root, { ...child(), request_id: "other-request" }],
    [root, { ...child(), session_id: "other-session" }],
    [root, { ...child(), router: "other-router" }],
    [root, { ...child(), upstream_inference_cost: null }],
    [root, { ...child(), total_cost: -1 }],
    [root, { ...child(), provider_responses: [] }],
    [root, { ...child(), id: "gen-child", upstream_id: null }],
    [root, child(), child()],
    [root, child("gen-a"), { ...child("gen-b"), upstream_id: "provider-gen-a" }, child("gen-c")],
    [{ ...root, total_cost: 0.1 }, child()],
    [{ ...root, session_id: null }, child()],
  ];
  for (const generations of cases) expect(await price(generations)).toBeUndefined();
});

test("indexing must settle and include every direct request before pricing", async () => {
  expect(
    await price([root, child()], (query) => (query === 1 ? [root] : [root, child()])),
  ).toBeCloseTo(0.21);
  expect(
    await price([root, child()], (query) => (query % 2 ? [root] : [root, child()])),
  ).toBeUndefined();
  expect(await price([root, child()], () => [child()])).toBeUndefined();
});

test("truncated analytics and errors fail closed; management access is never inferred from host env", async () => {
  for (const response of [
    () => Response.json({ data: { data: [], metadata: { row_count: 0, truncated: true } } }),
    () => new Response(null, { status: 403 }),
    () =>
      Response.json({
        data: { data: [{ generation_id: "gen-child", session_id: "session-trial" }], metadata: {} },
      }),
  ]) {
    const fetcher = (async (url: string) =>
      url.endsWith("/analytics/query")
        ? response()
        : Response.json({ data: root })) as unknown as typeof fetch;
    expect(
      await gatewayCost("openrouter", "inference", "pi", files(), fetcher, "management", noWait),
    ).toBeUndefined();
  }
  const { fetcher, requests } = ledger([root, child()]);
  expect(
    await gatewayCost("openrouter", "inference", "pi", files(), fetcher, undefined, noWait),
  ).toBeUndefined();
  expect(requests).toHaveLength(1);
});

test("accounting manifests preserve complete IDs but truncated logs cannot invent completeness", async () => {
  const whole = files();
  const archived = new Map<string, string>();
  openRouterManifest("pi", whole, archived);
  expect(JSON.parse(archived.get(OPENROUTER_GENERATIONS) ?? "{}").generationIds).toEqual([root.id]);
  expect(JSON.parse(archived.get(OPENROUTER_GENERATIONS) ?? "{}").generationIds).toEqual([root.id]);
  archived.set(OPENROUTER_GENERATIONS, '["gen-root","gen-root"]');
  expect(await gatewayCost("openrouter", "key", "pi", archived)).toBeUndefined();
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      modelName: "openrouter/example/router",
      credentials: {
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
        provider: "openrouter",
      },
    },
    "Router",
  );
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  expect(
    await billedTrialCost(
      run,
      { ...trial, modelVerified: true, harness: "pi" },
      { OPENROUTER_API_KEY: "key", OPENROUTER_MANAGEMENT_KEY: "operator" },
      files(),
    ),
  ).toEqual({});
  expect(trialCost(run, "pi", files(), {})).toEqual({
    modelVerified: true,
    tokenUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  });
});
