import { expect, test } from "bun:test";
import { initialEvaluation } from "../../../../src/evaluation/store";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";
import { benchmarkPoints, runAccuracy } from "./benchmark";

test("only complete, priced, verified runs enter the comparison", () => {
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      pricing: {
        input: 1,
        output: 1,
        cacheRead: 1,
        cacheWrite: 1,
        source: "https://example.test/pricing",
        asOf: "2026-09-05",
      },
    },
    "Test",
  );
  run.status = "completed";
  const trial = run.trials[0];
  if (!trial) throw new Error("No trial");
  trial.status = "completed";
  trial.rewards = { reward: 1 };
  trial.modelVerified = true;
  trial.apiCostUsd = 0.02;
  expect(benchmarkPoints([run])[0]).toMatchObject({ accuracy: 100, cost: 0.02 });
  delete run.pricing;
  trial.costSource = "harbor";
  expect(benchmarkPoints([run])[0]).toMatchObject({ accuracy: 100, cost: 0.02 });
  delete trial.apiCostUsd;
  expect(benchmarkPoints([run])).toEqual([]);
  expect(runAccuracy(run, "codex")).toBe(100);
  trial.status = "failed";
  expect(runAccuracy(run, "codex")).toBeUndefined();
});
test("dataset snapshots are order-independent and change when task bundles change", () => {
  const input = evaluationInput();
  input.tasks.push({ runId: "second", taskId: "second", bundleKey: "second.tar.gz" });
  const first = initialEvaluation(input, "Test").datasetKey;
  expect(
    initialEvaluation({ ...input, tasks: [...input.tasks].reverse() }, "Test").datasetKey,
  ).toBe(first);
  expect(
    initialEvaluation(
      {
        ...input,
        tasks: input.tasks.map((task) => ({ ...task, bundleKey: `${task.bundleKey}-new` })),
      },
      "Test",
    ).datasetKey,
  ).not.toBe(first);
});
