import { expect, test } from "bun:test";
import {
  DARI_REQUEST_IDS,
  dariRequestManifest,
  dariTrialCost,
} from "../src/evaluation/dari-cost.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const ids = ["35fcb4c6-5902-40a7-adfe-e9289cab6855", "980fa8d1-448d-4b9c-922d-200ef22d08cd"];
const files = new Map([
  [
    "solver/trial/agent/pi.txt",
    ids
      .map((id) =>
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            provider: "harbor-endpoint",
            model: "dari/routing",
            responseId: `chatcmpl-${id}`,
          },
        }),
      )
      .join("\n"),
  ],
]);
const run = initialEvaluation(
  {
    ...evaluationInput(),
    modelName: "openai/dari/routing",
    credentials: {
      provider: "custom",
      modelCredentialId: "model",
      sandboxCredentialId: "sandbox",
    },
  },
  "Dari Router",
);
const env = { OPENAI_BASE_URL: "https://routing.dari.dev/v1", OPENAI_API_KEY: "key" };
const firstTrial = run.trials[0];
if (!firstTrial) throw new Error("Fixture trial missing");
const trial = { ...firstTrial, harness: "pi" as const };
const data = ids.map((id, i) => ({
  request_id: id,
  model_cost_usd: i ? "0.02" : "0.1",
  selected_model: "model",
  observed: true,
}));

test("custom Dari replies are verified by authenticated per-request pricing without cash billing", async () => {
  const result = await dariTrialCost(run, trial, env, files, (async (url, init) => {
    expect(url).toBe("https://routing.dari.dev/v1/request-costs");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ request_ids: ids });
    return Response.json({ complete: true, data });
  }) as typeof fetch);
  expect(result).toEqual({
    apiCostUsd: 0.12000000000000001,
    modelVerified: true,
    costSource: "router-reference-rates",
  });
  expect(result).not.toHaveProperty("billedCostUsd");
});

test("persists compact IDs rather than deriving a whole-trial price from truncated logs", () => {
  expect(dariRequestManifest(files)?.requestIds).toEqual(ids);
  const tail = new Map([
    ["agent/pi.txt", `[Earlier output truncated]\n${files.values().next().value}`],
  ]);
  expect(dariRequestManifest(tail)).toBeUndefined();
  tail.set(DARI_REQUEST_IDS, JSON.stringify(dariRequestManifest(files)));
  expect(dariRequestManifest(tail)?.requestIds).toEqual(ids);
  expect(
    dariRequestManifest(
      new Map([[DARI_REQUEST_IDS, '{"model":"dari/routing","requestIds":["invalid"]}']]),
    ),
  ).toBeUndefined();
});

test("rejects duplicate IDs, incomplete lines, wrong models, and missing response IDs", () => {
  const original = files.values().next().value ?? "";
  for (const text of [
    `${original}\n${original}`,
    `${original}\n{"type":`,
    original.replaceAll("dari/routing", "other"),
    original.replaceAll("chatcmpl-", "gen-"),
  ]) {
    expect(dariRequestManifest(new Map([["agent/pi.txt", text]]))).toBeUndefined();
  }
});

test("only Dari endpoint and Pi route can send the custom credential", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    return Response.json({ complete: true, data: data.map((r) => ({ ...r, observed: true })) });
  }) as unknown as typeof fetch;
  for (const endpoint of [
    "https://other.example/v1",
    "http://routing.dari.dev",
    "https://routing.dari.dev:8443/v1",
    "https://user@routing.dari.dev/v1",
  ]) {
    expect(
      await dariTrialCost(run, trial, { ...env, OPENAI_BASE_URL: endpoint }, files, fetcher),
    ).toEqual({});
  }
  expect(await dariTrialCost(run, { ...trial, harness: "codex" }, env, files, fetcher)).toEqual({});
  expect(
    await dariTrialCost({ ...run, modelName: "openai/other" }, trial, env, files, fetcher),
  ).toEqual({});
  expect(called).toBe(false);
});

test("delayed ingest retries, but missing or malformed records never yield a partial price", async () => {
  let calls = 0;
  const fetcher = (async () =>
    Response.json({
      complete: true,
      data: ++calls === 1 ? data.slice(0, 1) : data,
    })) as unknown as typeof fetch;
  expect(
    (await dariTrialCost(run, trial, env, files, fetcher, async () => {})).apiCostUsd,
  ).toBeCloseTo(0.12);
  expect(calls).toBe(2);
  for (const rows of [
    data.slice(0, 1),
    [data[0], data[0]],
    [data[0], { ...data[1], model_cost_usd: null }],
    [data[0], { ...data[1], model_cost_usd: "-1" }],
  ]) {
    expect(
      await dariTrialCost(
        run,
        trial,
        env,
        files,
        (async () => Response.json({ complete: true, data: rows })) as unknown as typeof fetch,
        async () => {},
      ),
    ).toEqual({});
  }
  expect(
    await dariTrialCost(
      run,
      trial,
      env,
      files,
      (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    ),
  ).toEqual({});
  expect(
    await dariTrialCost(run, trial, env, files, (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch),
  ).toEqual({});
});

test("rejects neighboring conversation requests and capped responses", async () => {
  for (const body of [
    { complete: false, data },
    { data },
    {
      complete: true,
      data: [
        ...data,
        {
          request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          model_cost_usd: "0.03",
          selected_model: "model",
          observed: false,
        },
      ],
    },
    {
      complete: true,
      data: [
        ...data,
        {
          request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          model_cost_usd: "0.03",
          selected_model: "model",
          observed: true,
        },
      ],
    },
  ]) {
    expect(
      await dariTrialCost(
        run,
        trial,
        env,
        files,
        (async () => Response.json(body)) as unknown as typeof fetch,
        async () => {},
      ),
    ).toEqual({});
  }
});

test("zero is valid only when explicitly priced", async () => {
  const result = await dariTrialCost(run, trial, env, files, (async () =>
    Response.json({
      complete: true,
      data: data.map((r) => ({ ...r, model_cost_usd: "0" })),
    })) as unknown as typeof fetch);
  expect(result.apiCostUsd).toBe(0);
});
