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
  expect(trialCost(run, "pi", files(), result).apiCostUsd).toBeUndefined();
  event.message.usage.cost.cacheWrite = 0.4;
  expect(trialCost(run, "pi", files(), result).apiCostUsd).toBeUndefined();
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
