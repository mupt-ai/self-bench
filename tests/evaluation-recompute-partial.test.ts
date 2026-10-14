import { expect, test } from "bun:test";
import { recomputeEvaluationCost } from "../maintenance/recompute-cost.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

test("recompute preserves a recovered prefix subtotal with no complete transcript or token aggregate", async () => {
  const { store, input } = await runnerFixture();
  const run = initialEvaluation({ ...input, id: crypto.randomUUID(), harnesses: ["codex"] }, "Sol");
  run.status = "completed";
  const trial = run.trials[0];
  if (!trial) throw new Error("Fixture trial missing");
  trial.status = "completed";
  trial.apiCostUsd = 0.2;
  trial.costIncomplete = true;
  trial.costSource = "reference-rates";
  trial.modelVerified = true;
  trial.artifacts = ["0/solver/task/result.json", "0/solver/task/agent/trajectory.json"];
  await store.put(
    `${evaluationPrefix(run.repoId, run.id)}artifacts/${trial.artifacts[0]}`,
    Buffer.from("{}"),
    "application/json",
  );
  await store.put(
    `${evaluationPrefix(run.repoId, run.id)}artifacts/${trial.artifacts[1]}`,
    Buffer.from('{"steps":[{"source":"agent"'),
    "application/json",
  );
  await saveEvaluation(store, run);
  expect((await recomputeEvaluationCost(store, run.repoId, run.id, true)).applied).toBe(false);
  expect((await getEvaluation(store, run.repoId, run.id))?.trials[0]).toMatchObject({
    apiCostUsd: 0.2,
    costIncomplete: true,
  });
});
