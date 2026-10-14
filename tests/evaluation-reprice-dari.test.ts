import { expect, test } from "bun:test";
import { recomputeEvaluationCost } from "../maintenance/recompute-cost.js";
import { repriceDariRouter } from "../maintenance/reprice-dari-router.js";
import { DARI_REQUEST_IDS } from "../src/evaluation/dari/cost.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

const env = { OPENAI_BASE_URL: "https://routing.dari.dev/v1", OPENAI_API_KEY: "key" };

test("Dari reprice is dry by default, preserves snapshots, and general recompute leaves its price intact", async () => {
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
  const id = "35fcb4c6-5902-40a7-adfe-e9289cab6855";
  const name = `0/${DARI_REQUEST_IDS}`;
  trial.artifacts = [name];
  await store.put(
    `${evaluationPrefix(run.repoId, run.id)}artifacts/${name}`,
    Buffer.from(
      JSON.stringify({
        model: "dari/routing",
        requestIds: [id],
      }),
    ),
    "application/json",
  );
  await saveEvaluation(store, run);
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      complete: true,
      data: [{ request_id: id, selected_model: "model", model_cost_usd: "0.2", observed: true }],
    })) as unknown as typeof fetch;
  try {
    expect((await repriceDariRouter(store, run.repoId, run.id, env, false)).applied).toBe(false);
    expect((await getEvaluation(store, run.repoId, run.id))?.trials[0]?.apiCostUsd).toBeUndefined();
    expect((await repriceDariRouter(store, run.repoId, run.id, env, true)).applied).toBe(true);
    expect((await getEvaluation(store, run.repoId, run.id))?.trials[0]?.apiCostUsd).toBe(0.2);
    expect((await repriceDariRouter(store, run.repoId, run.id, env, true)).applied).toBe(false);
    expect((await recomputeEvaluationCost(store, run.repoId, run.id, true)).applied).toBe(false);
    expect((await getEvaluation(store, run.repoId, run.id))?.trials[0]?.apiCostUsd).toBe(0.2);
  } finally {
    globalThis.fetch = original;
  }
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
  await expect(repriceDariRouter(store, run.repoId, run.id, env, true)).rejects.toThrow(
    "still in progress",
  );
});
