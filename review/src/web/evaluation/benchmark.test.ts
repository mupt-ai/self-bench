import { expect, test } from "bun:test";
import { initialEvaluation } from "../../../../src/evaluation/store";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";

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
