import { expect, test } from "bun:test";
import { recomputeEvaluationCost } from "../maintenance/recompute-cost.js";
import { repriceDariRouter } from "../maintenance/reprice-dari-router.js";
import { DARI_BILLING } from "../src/evaluation/dari/billing.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

test("Dari reprice restores response prices from evidence and recompute leaves the price intact", async () => {
  const { store, input } = await runnerFixture();
  const run = initialEvaluation(
    {
      ...input,
      id: crypto.randomUUID(),
      modelName: "openai/dari/routing",
      credentials: {
        provider: "custom",
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
      },
      harnesses: ["pi"],
    },
    "Dari Router",
  );
  run.status = "completed";
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing fixture trial");
  trial.status = "completed";
  const name = `0/${DARI_BILLING}`;
  trial.artifacts = [name];
  await store.put(
    `${evaluationPrefix(run.repoId, run.id)}artifacts/${name}`,
    Buffer.from(
      [
        JSON.stringify({ type: "request", index: 1 }),
        JSON.stringify({ type: "cost", index: 1, requestId: crypto.randomUUID(), cost: 0.2 }),
      ].join("\n"),
    ),
    "application/jsonl",
  );
  await saveEvaluation(store, run);
  expect((await repriceDariRouter(store, run.repoId, run.id, false)).applied).toBe(false);
  expect((await getEvaluation(store, run.repoId, run.id))?.trials[0]?.apiCostUsd).toBeUndefined();
  expect((await repriceDariRouter(store, run.repoId, run.id, true)).applied).toBe(true);
  expect((await getEvaluation(store, run.repoId, run.id))?.trials[0]?.apiCostUsd).toBe(0.2);
  expect((await repriceDariRouter(store, run.repoId, run.id, true)).applied).toBe(false);
  expect((await recomputeEvaluationCost(store, run.repoId, run.id, true)).applied).toBe(false);
  expect((await getEvaluation(store, run.repoId, run.id))?.trials[0]?.apiCostUsd).toBe(0.2);
});

test("Dari repricing refuses active runs", async () => {
  const { store, input } = await runnerFixture();
  const run = initialEvaluation(
    {
      ...input,
      id: crypto.randomUUID(),
      modelName: "openai/dari/routing",
      credentials: {
        provider: "custom",
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
      },
    },
    "Dari Router",
  );
  run.status = "running";
  await saveEvaluation(store, run);
  await expect(repriceDariRouter(store, run.repoId, run.id, true)).rejects.toThrow(
    "still in progress",
  );
});
