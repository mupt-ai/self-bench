import { expect, test } from "bun:test";
import { trialCost } from "../../src/evaluation/cost.js";
import { initialEvaluation } from "../../src/evaluation/store.js";
import { evaluationInput } from "../support/evaluation-fixture.js";

// Sonnet 5's list rates, and the requests of a real Claude sign-in trial, whose Claude Code
// reported a list-price total of $0.0458814: its sign-in caches every write for an hour.
const pricing = {
  input: 2,
  output: 10,
  cacheRead: 0.2,
  cacheWrite: 2.5,
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  asOf: "2026-09-23",
  maxInputTokens: 200_000,
};
const step = (prompt: number, output: number, cached: number, written: number) => ({
  source: "agent",
  model_name: "claude-sonnet-5",
  metrics: {
    prompt_tokens: prompt,
    completion_tokens: output,
    cached_tokens: cached,
    // Harbor's estimate prices these writes at the five-minute rate.
    cost_usd: 0,
    extra: {
      cache_creation_input_tokens: written,
      cache_creation: { ephemeral_1h_input_tokens: written, ephemeral_5m_input_tokens: 0 },
    },
  },
});
const steps = [step(27_339, 79, 18_570, 8_767), step(27_495, 21, 27_337, 156)];
const result = {
  agent_result: { n_input_tokens: 54_834, n_cache_tokens: 45_907, n_output_tokens: 100 },
};
const run = initialEvaluation(
  { ...evaluationInput(), modelName: "anthropic/claude-sonnet-5", pricing },
  "Test",
);
const files = (value: object) =>
  new Map([["solver/t/agent/trajectory.json", JSON.stringify(value)]]);

test("Claude Code trials are priced at list rates, hour-long cache writes included", () => {
  const cost = trialCost(run, "claude-code", files({ steps }), result);
  expect(cost).toMatchObject({
    modelVerified: true,
    tokenUsage: { input: 4, output: 100, cacheRead: 45_907, cacheWrite: 8_923 },
    costSource: "reference-rates",
  });
  expect(cost.apiCostUsd).toBeCloseTo(0.0458814, 10);
  // Claude Code records an API error as a usage-free "<synthetic>" message.
  const synthetic = { ...step(0, 0, 0, 0), model_name: "<synthetic>" };
  expect(
    trialCost(run, "claude-code", files({ steps: [...steps, synthetic] }), result).apiCostUsd,
  ).toBeCloseTo(0.0458814, 10);
});

test("a Claude Code trial whose requests do not add up to Harbor's totals gets no cost", () => {
  expect(trialCost(run, "claude-code", files({ steps: steps.slice(1) }), result)).toEqual({});
  const other = steps.map((entry) => ({ ...entry, model_name: "claude-haiku-4-5" }));
  expect(trialCost(run, "claude-code", files({ steps: other }), result).apiCostUsd).toBeUndefined();
});
