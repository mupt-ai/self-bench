import { isDeepStrictEqual } from "node:util";
import { type ArtifactStore, createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { openDatabase } from "../src/db/client.js";
import { createCredentialStore } from "../src/db/credentials.js";
import { dariTrialCost, isDariRun } from "../src/evaluation/dari-cost.js";
import { evaluationCredentialOrg } from "../src/evaluation/execution.js";
import { getEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { storedHarborFiles } from "./recompute-cost.js";

/** Finished runs only; missing IDs or prices keep the trial unchanged, never partial. */
export async function repriceDariRouter(
  store: ArtifactStore,
  repoId: number,
  id: string,
  env: NodeJS.ProcessEnv,
  apply: boolean,
) {
  const run = await getEvaluation(store, repoId, id);
  if (!run || !isDariRun(run)) throw new Error("Dari router evaluation not found");
  if (run.status === "running" || run.status === "queued") throw new Error("Evaluation is still in progress");
  const trials = [];
  for (const [index, trial] of run.trials.entries()) {
    if (trial.status !== "completed") {
      trials.push({ index, taskId: trial.taskId, after: {}, changed: false });
      continue;
    }
    const { files } = await storedHarborFiles(store, run, trial);
    const after = await dariTrialCost(run, trial, env, files);
    const before = { apiCostUsd: trial.apiCostUsd, costSource: trial.costSource, modelVerified: trial.modelVerified };
    const changed = after.apiCostUsd !== undefined && !isDeepStrictEqual(before, after);
    trials.push({ index, taskId: trial.taskId, before, after, changed });
    if (changed) Object.assign(trial, after);
  }
  const applied = apply && trials.some((t) => t.changed);
  if (applied) await saveEvaluation(store, run);
  return { trials, applied };
}

export async function main() {
  const [repo, id] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!repo || !/^\d+$/.test(repo) || !id) throw new Error("Usage: reprice-dari-router.js <repoId> <evaluationId> [--apply]");
  const store = createArtifactStore(loadConfig().artifact);
  const run = await getEvaluation(store, Number(repo), id);
  if (!run || !isDariRun(run)) throw new Error("Dari router evaluation not found");
  const url = process.env.SELFBENCH_DATABASE_URL;
  const key = process.env.SELFBENCH_EVAL_CREDENTIAL_KEY;
  const orgId = evaluationCredentialOrg(run);
  if (!url || !key || !orgId || !run.credentials) throw new Error("Database and evaluation credential configuration required");
  const db = await openDatabase(url, { light: true });
  try {
    const credentials = createCredentialStore(db.db, key);
    const credential = await credentials.find(orgId, run.credentials.modelCredentialId);
    const secret = await credentials.secret(orgId, run.credentials.modelCredentialId);
    if (!credential?.endpoint || !secret?.value) throw new Error("Model credential unavailable");
    const report = await repriceDariRouter(store, Number(repo), id, {
      OPENAI_BASE_URL: credential.endpoint, OPENAI_API_KEY: secret.value,
    }, process.argv.includes("--apply"));
    console.log(JSON.stringify(report, null, 2));
  } finally { await db.close(); }
}
