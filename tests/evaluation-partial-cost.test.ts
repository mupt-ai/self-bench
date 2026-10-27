import { expect, test } from "bun:test";
import { partialCodexCost, prefixSteps } from "../maintenance/partial-cost.js";
import { costTotal, knownCostLabel } from "../src/evaluation/cost-total.js";
import { responseCost } from "../src/evaluation/dari/billing.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const id = crypto.randomUUID();
const events = (...costs: unknown[]) =>
  costs
    .flatMap((cost, index) => [
      JSON.stringify({ type: "request", index: index + 1 }),
      JSON.stringify({
        type: "cost",
        index: index + 1,
        requestId: index ? crypto.randomUUID() : id,
        cost,
      }),
    ])
    .join("\n");

test("unpriced requests add nothing to the bill, but invalid structure proves none", () => {
  expect(responseCost(events(0.02, null, 0.03))).toBe(0.05);
  expect(responseCost(events(null))).toBe(0);
  expect(responseCost(`${events(0.02)}\n${JSON.stringify({ type: "request", index: 2 })}`)).toBe(
    0.02,
  );
  expect(responseCost(`${events(0.02)}\n{broken`)).toBeUndefined();
  expect(responseCost("")).toBeUndefined();
  expect(
    responseCost(
      `${events(0.02, 0.03)}\n${JSON.stringify({ type: "cost", index: 1, requestId: id, cost: null })}`,
    ),
  ).toBe(0.03);
});

test("a setting's cost per task is the mean of its priced trials", () => {
  expect(costTotal([{ apiCostUsd: 2 }, {}, { apiCostUsd: 3 }])).toEqual({
    total: 5,
    known: 2,
    perTask: 2.5,
  });
  expect(costTotal([{}])).toEqual({ total: 0, known: 0 });
  expect(knownCostLabel(5, String)).toBe("5");
  expect(knownCostLabel(0, String, 0)).toBe("Not Available");
});

test("truncated JSON recovers only whole saved request metrics as a subtotal", () => {
  const run = initialEvaluation(evaluationInput(), "Sol");
  run.modelName = "openai/gpt-6.1-sol";
  run.credentials = {
    provider: "openai",
    modelCredentialId: "model",
    sandboxCredentialId: "sandbox",
  };
  run.pricing = {
    input: 2,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    output: 10,
    source: "test",
    asOf: "test",
  };
  const initial = run.trials[0];
  if (!initial) throw new Error("Fixture trial missing");
  const trial = { ...initial, harness: "codex" as const, modelVerified: true };
  const step = {
    source: "agent",
    model_name: run.modelName,
    message: 'nested { braces } "quoted"',
    metrics: { prompt_tokens: 2000, completion_tokens: 100, cached_tokens: 1000 },
  };
  const text = `{"steps":[${JSON.stringify(step)},{"source":"agent","message":"cut`;
  expect(prefixSteps(text)).toEqual([step]);
  expect(partialCodexCost(run, trial, text, "codex-login")).toEqual({
    apiCostUsd: 0.0036,
    costSource: "reference-rates",
  });
  expect(partialCodexCost(run, trial, text, undefined)).toBeUndefined();
  expect(prefixSteps('[Earlier output truncated]\n{"steps":[]')).toEqual([]);
});
