import { expect, test } from "bun:test";
import { trialCost } from "../src/evaluation/cost.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const pricing = {
  input: 2,
  output: 8,
  cacheRead: 0.5,
  cacheWrite: 2.5,
  source: "https://provider.example/pricing",
  asOf: "2026-09-05",
};

function makeRun(
  harness: "mini-swe-agent" | "terminus-2",
  provider?: "openai" | "vercel-ai-gateway",
) {
  const input = evaluationInput();
  return initialEvaluation(
    {
      ...input,
      harnesses: [harness],
      modelName: "openai/test-model",
      model: "test-model",
      pricing,
      ...(provider
        ? {
            credentials: {
              modelCredentialId: "model",
              sandboxCredentialId: "sandbox",
              provider,
            },
          }
        : {}),
    },
    "Test",
  );
}

function atif(model = "test-model", extras: Record<string, unknown> = {}) {
  return {
    agent: { model_name: model },
    steps: [
      {
        source: "agent",
        model_name: model,
        metrics: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          cached_tokens: 200,
          cost_usd: 0.004,
          extra: extras,
        },
      },
      {
        source: "agent",
        model_name: model,
        metrics: {
          prompt_tokens: 1500,
          completion_tokens: 25,
          cached_tokens: 100,
          cost_usd: 0.003,
          extra: extras,
        },
      },
    ],
  };
}

function result(extra: Record<string, unknown> = {}) {
  return {
    agent_result: {
      n_input_tokens: 2500,
      n_cache_tokens: 300,
      n_output_tokens: 75,
      cost_usd: 0.007,
      ...extra,
    },
  };
}

const files = (trajectory: unknown) =>
  new Map([["solver/trial/agent/trajectory.json", JSON.stringify(trajectory)]]);

test.each(["mini-swe-agent", "terminus-2"] as const)(
  "%s measures verified ATIF usage and Harbor cost",
  (harness) => {
    expect(trialCost(makeRun(harness), harness, files(atif()), result())).toEqual({
      modelVerified: true,
      tokenUsage: { input: 2200, output: 75, cacheRead: 300, cacheWrite: 0 },
      apiCostUsd: 0.007,
      costSource: "harbor",
    });
  },
);

test("Mini-SWE-Agent records cache writes in prompt token details", () => {
  const trajectory = atif();
  const first = trajectory.steps[0];
  const second = trajectory.steps[1];
  if (!first || !second) throw new Error("Missing fixture steps");
  first.metrics.extra = { prompt_tokens_details: { cache_creation_tokens: 500 } };
  second.metrics.extra = { prompt_tokens_details: { cache_creation_tokens: 250 } };
  const actualResult = result({ n_input_tokens: 2500 });
  expect(
    trialCost(makeRun("mini-swe-agent"), "mini-swe-agent", files(trajectory), actualResult),
  ).toEqual({
    modelVerified: true,
    tokenUsage: { input: 1450, output: 75, cacheRead: 300, cacheWrite: 750 },
    apiCostUsd: 0.007,
    costSource: "harbor",
  });
});

test("cache writes unavailable means no Anthropic-premium reference estimate", () => {
  const run = makeRun("terminus-2", "vercel-ai-gateway");
  expect(trialCost(run, "terminus-2", files(atif()), result())).toMatchObject({
    modelVerified: true,
    tokenUsage: { input: 2200, output: 75, cacheRead: 300, cacheWrite: 0 },
  });
  expect(trialCost(run, "terminus-2", files(atif()), result())).toEqual({
    modelVerified: true,
    tokenUsage: { input: 2200, output: 75, cacheRead: 300, cacheWrite: 0 },
  });
});

test("OpenRouter retains measured usage without attributing a model cost", () => {
  const run = makeRun("mini-swe-agent", "openai");
  if (run.credentials) run.credentials.provider = "openrouter";
  expect(trialCost(run, "mini-swe-agent", files(atif()), result())).toEqual({
    modelVerified: true,
    tokenUsage: { input: 2200, output: 75, cacheRead: 300, cacheWrite: 0 },
  });
});

test("mismatched model and invalid usage are not priced", () => {
  expect(
    trialCost(makeRun("terminus-2"), "terminus-2", files(atif("other-model")), result()),
  ).toMatchObject({ modelVerified: false });
  expect(
    trialCost(makeRun("terminus-2"), "terminus-2", files(atif()), result({ n_cache_tokens: 3000 }))
      .apiCostUsd,
  ).toBeUndefined();
});
