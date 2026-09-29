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
test("Harbor request costs work without reference pricing and preserve cache writes", () => {
  const run = initialEvaluation(evaluationInput(), "Test");
  const trajectory = {
    agent: { model_name: "test-model" },
    final_metrics: { extra: { total_cache_write_input_tokens: 30 } },
    steps: [
      {
        source: "agent",
        metrics: {
          prompt_tokens: 300000,
          completion_tokens: 100,
          cached_tokens: 200000,
          cost_usd: 1.23,
          extra: { cache_write_input_tokens: 30 },
        },
      },
    ],
  };
  const files = () => new Map([["agent/trajectory.json", JSON.stringify(trajectory)]]);
  const result = {
    agent_result: {
      n_input_tokens: 300000,
      n_cache_tokens: 200000,
      n_output_tokens: 100,
      cost_usd: 1.23,
    },
  };
  expect(trialCost(run, "codex", files(), result)).toEqual({
    modelVerified: true,
    tokenUsage: { input: 99970, output: 100, cacheRead: 200000, cacheWrite: 30 },
    apiCostUsd: 1.23,
    costSource: "harbor",
  });
  result.agent_result.cost_usd = 5;
  expect(trialCost(run, "codex", files(), result).apiCostUsd).toBeUndefined();
  result.agent_result.cost_usd = 1.23;
  const step = trajectory.steps[0];
  if (!step) throw new Error("Missing step");
  step.metrics.cached_tokens -= 1;
  expect(trialCost(run, "codex", files(), result).apiCostUsd).toBeUndefined();
});

test("Pi dollar totals cannot invent pricing for unknown models", () => {
  const run = initialEvaluation(evaluationInput(), "Test");
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 80,
        cacheWrite: 20,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
      },
    },
  };
  const files = () => new Map([["agent/pi.txt", JSON.stringify(event)]]);
  const result = { agent_result: { cost_usd: 0.37 } };
  // The run is verified and its tokens measured, so the missing cost is down to missing pricing.
  expect(trialCost(run, "pi", files(), result)).toEqual({
    modelVerified: true,
    tokenUsage: { input: 100, output: 50, cacheRead: 80, cacheWrite: 20 },
  });
});

test("cost uses token counts and explicit rates, never Harbor's unverified cost_usd", () => {
  const run = initialEvaluation({ ...evaluationInput(), pricing }, "Test");
  const files = new Map([
    [
      "solver/trial/agent/trajectory.json",
      JSON.stringify({ steps: [{ source: "agent", model_name: "test-model" }] }),
    ],
  ]);
  const result = {
    agent_result: {
      n_input_tokens: 1000,
      n_cache_tokens: 200,
      n_output_tokens: 100,
      cost_usd: 10000,
    },
  };
  expect(trialCost(run, "codex", files, result)).toEqual({
    modelVerified: true,
    apiCostUsd: 0.0025,
    tokenUsage: { input: 800, output: 100, cacheRead: 200, cacheWrite: 0 },
    costSource: "reference-rates",
  });
  expect(trialCost(initialEvaluation(evaluationInput(), "Test"), "codex", files, result)).toEqual({
    modelVerified: true,
    tokenUsage: { input: 800, output: 100, cacheRead: 200, cacheWrite: 0 },
  });
});
test("unverified models and unknown usage never get an invented zero cost", () => {
  const run = initialEvaluation({ ...evaluationInput(), pricing }, "Test");
  const files = new Map([
    [
      "solver/trial/agent/trajectory.json",
      JSON.stringify({ steps: [{ source: "agent", model_name: "different-model" }] }),
    ],
  ]);
  expect(
    trialCost(run, "codex", files, { agent_result: { cost_usd: 0 } }).apiCostUsd,
  ).toBeUndefined();
  expect(trialCost(run, "claude-code", files, {}).apiCostUsd).toBeUndefined();
});
test("Pi cache-write tokens are charged separately and truncated events fail closed", () => {
  const run = initialEvaluation({ ...evaluationInput(), pricing }, "Test");
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-model",
      usage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 },
    },
  });
  expect(trialCost(run, "pi", new Map([["solver/trial/agent/pi.txt", event]]), {})).toEqual({
    modelVerified: true,
    apiCostUsd: 0.0013,
    tokenUsage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 },
    costSource: "reference-rates",
  });
  expect(
    trialCost(run, "pi", new Map([["solver/trial/agent/pi.txt", `${event}\n{"partial"`]]), {})
      .apiCostUsd,
  ).toBeUndefined();
});

test("Codex sign-in bills eligible unreported fresh input as cache writes, like Dari", () => {
  const luna = { ...pricing, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
  const input = { ...evaluationInput(), pricing: { ...luna, maxInputTokens: 40_000 } };
  const signIn = initialEvaluation(
    {
      ...input,
      credentials: {
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
        provider: "openai",
        auth: "codex-login",
      },
    },
    "Test",
  );
  // Shaped like Harbor's Codex trajectory for a sign-in run: writes always reported as zero.
  const call = (prompt: number, cached: number, output: number, cost: number, written = 0) => ({
    source: "agent",
    model_name: "test-model",
    metrics: {
      prompt_tokens: prompt,
      completion_tokens: output,
      ...(cached ? { cached_tokens: cached } : {}),
      cost_usd: cost,
      extra: { cache_write_input_tokens: written },
    },
  });
  const trajectory = {
    final_metrics: { extra: { total_cache_write_input_tokens: 5000 } },
    steps: [
      call(22_980, 11_008, 236, 0.001), // cacheable: 11,972 fresh tokens become writes
      call(800, 0, 10, 0.0001), // under OpenAI's 1,024-token minimum: stays input
      call(30_000, 20_000, 100, 0.002, 5000), // writes reported: left as reported
    ],
  };
  const files = () => new Map([["solver/trial/agent/trajectory.json", JSON.stringify(trajectory)]]);
  // The trial's 53,780 prompt tokens exceed the 40,000 per-request bound; no single request does.
  const result = {
    agent_result: {
      n_input_tokens: 53_780,
      n_cache_tokens: 31_008,
      n_output_tokens: 346,
      cost_usd: 0.0031,
    },
  };
  const inferred = trialCost(signIn, "codex", files(), result);
  expect(inferred).toMatchObject({
    modelVerified: true,
    tokenUsage: { input: 5800, output: 346, cacheRead: 31_008, cacheWrite: 16_972 },
    cacheWritesInferred: true,
    costSource: "reference-rates",
  });
  expect(inferred.apiCostUsd).toBeCloseTo(
    (5800 * 0.1 + 346 * 0.5 + 31_008 * 0.01 + 16_972 * 0.125) / 1_000_000,
    12,
  );
  // An API key reports its own writes, so Harbor's per-request cost stands.
  expect(trialCost(signIn, "codex", files(), result, "api-key")).toEqual({
    modelVerified: true,
    tokenUsage: { input: 17_772, output: 346, cacheRead: 31_008, cacheWrite: 5000 },
    apiCostUsd: 0.0031,
    costSource: "harbor",
  });
  // A request beyond the per-request bound, or records that disagree, leave the cost unknown.
  const [first] = trajectory.steps;
  if (!first) throw new Error("Missing step");
  first.metrics.prompt_tokens += 20_000;
  const bigger = { agent_result: { ...result.agent_result, n_input_tokens: 73_780 } };
  expect(trialCost(signIn, "codex", files(), bigger).apiCostUsd).toBeUndefined();
  first.metrics.prompt_tokens -= 20_000;
  expect(trialCost(signIn, "codex", files(), bigger)).toEqual({
    modelVerified: true,
    tokenUsage: { input: 37_772, output: 346, cacheRead: 31_008, cacheWrite: 5000 },
  });
});

test("OpenRouter Codex trials verify against the gateway model name Harbor records", () => {
  const input = {
    ...evaluationInput(),
    model: "gpt-6-astra",
    modelName: "openrouter/openai/gpt-6-astra",
    credentials: {
      modelCredentialId: "managed-model",
      sandboxCredentialId: "managed-sandbox",
      provider: "openrouter" as const,
    },
  };
  const run = initialEvaluation({ ...input, pricing }, "Test");
  // Shaped like Harbor 0.x Codex output: every agent step carries the model Harbor was given,
  // and a call with no cache read omits cached_tokens.
  const trajectory = (model: string) => ({
    agent: { name: "codex", model_name: "openai/gpt-6-astra" },
    final_metrics: { total_cost_usd: 0.43, extra: { total_cache_write_input_tokens: 29793 } },
    steps: [
      { step_id: 1, source: "user", message: "Fix the bug" },
      {
        step_id: 2,
        source: "agent",
        model_name: model,
        metrics: {
          prompt_tokens: 25796,
          completion_tokens: 156,
          cost_usd: 0.33,
          extra: { cache_write_input_tokens: 25793 },
        },
      },
      {
        step_id: 3,
        source: "agent",
        model_name: model,
        metrics: {
          prompt_tokens: 30000,
          completion_tokens: 100,
          cached_tokens: 25793,
          cost_usd: 0.1,
          extra: { cache_write_input_tokens: 4000 },
        },
      },
    ],
  });
  const files = (model: string) =>
    new Map([["solver/trial/agent/trajectory.json", JSON.stringify(trajectory(model))]]);
  const result = {
    agent_result: {
      n_input_tokens: 55796,
      n_cache_tokens: 25793,
      n_output_tokens: 256,
      cost_usd: 0.43,
    },
  };
  const usage = { input: 210, output: 256, cacheRead: 25793, cacheWrite: 29793 };
  expect(trialCost(run, "codex", files("openai/openai/gpt-6-astra"), result)).toEqual({
    modelVerified: true,
    tokenUsage: usage,
    apiCostUsd: 0.43,
    costSource: "harbor",
  });
  expect(trialCost(run, "codex", files("openai/openai/gpt-6-other"), result)).toEqual({
    modelVerified: false,
    tokenUsage: usage,
  });
  // A direct OpenAI key never passes Harbor the doubled gateway prefix, so it is not accepted.
  const direct = initialEvaluation(
    {
      ...input,
      modelName: "openai/gpt-6-astra",
      credentials: { ...input.credentials, provider: "openai" },
    },
    "Test",
  );
  expect(trialCost(direct, "codex", files("openai/openai/gpt-6-astra"), result).modelVerified).toBe(
    false,
  );
});
