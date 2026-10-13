import { isDeepStrictEqual } from "node:util";
import { type ArtifactStore, createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { openDatabase } from "../src/db/client.js";
import { createCredentialStore } from "../src/db/credentials.js";
import { evaluationCredentialOrg } from "../src/evaluation/execution.js";
import { billedTrialCost } from "../src/evaluation/gateway-cost.js";
import { OPENROUTER_BILLING } from "../src/gateways/openrouter/billing.js";
import { evaluationPrefix, getEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { storedHarborFiles } from "./recompute-cost.js";

/** Exact complete records only. Dry runs never write artifacts or evaluation snapshots. */
export async function repriceOpenRouter(
  store: ArtifactStore, repoId: number, id: string,
  key: string, managementKey: string | undefined, apply: boolean,
) {
  const run = await getEvaluation(store, repoId, id);
  if (!run || run.credentials?.provider !== "openrouter")
    throw new Error("OpenRouter evaluation not found");
  if (run.status === "running" || run.status === "queued") throw new Error("Evaluation is still in progress");
  const trials = [];
  for (const [index, trial] of run.trials.entries()) {
    if (trial.status !== "completed") continue;
    const { files } = await storedHarborFiles(store, run, trial);
    // A historical reference-rate/subtotal price must not prevent the recovered bill standing in.
    const { apiCostUsd: _previousCost, ...unpriced } = trial;
    const after = await billedTrialCost(run, unpriced, { OPENROUTER_API_KEY: key }, files, managementKey);
    const before = { apiCostUsd: trial.apiCostUsd, billedCostUsd: trial.billedCostUsd, costSource: trial.costSource };
    const bill = files.get(OPENROUTER_BILLING);
    const complete = after.apiCostUsd !== undefined && !!bill;
    const changed = complete && !isDeepStrictEqual(before, after);
    trials.push({ index, taskId: trial.taskId, before, after, complete, changed });
    if (apply && complete) {
      const name = `${index}/${OPENROUTER_BILLING}`;
      await store.put(`${evaluationPrefix(repoId, id)}artifacts/${name}`, Buffer.from(bill), "application/json");
      if (!trial.artifacts.includes(name)) trial.artifacts.push(name);
      Object.assign(trial, after);
    }
  }
  const applied = apply && trials.some((trial) => trial.complete);
  if (applied) await saveEvaluation(store, run);
  return { trials, applied };
}

export async function main() {
  const [repo, id] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!repo || !/^\d+$/.test(repo) || !id) throw new Error("Usage: reprice-openrouter.js <repoId> <evaluationId> [--apply]");
  const store = createArtifactStore(loadConfig().artifact);
  const run = await getEvaluation(store, Number(repo), id);
  const url = process.env.SELFBENCH_DATABASE_URL;
  const encryptionKey = process.env.SELFBENCH_EVAL_CREDENTIAL_KEY;
  const orgId = run && evaluationCredentialOrg(run);
  if (!url || !encryptionKey || !orgId || !run?.credentials) throw new Error("Database and evaluation credential configuration required");
  const db = await openDatabase(url, { light: true });
  try {
    const credentials = createCredentialStore(db.db, encryptionKey);
    const secret = await credentials.secret(orgId, run.credentials.modelCredentialId);
    if (!secret?.value) throw new Error("Owner's OpenRouter inference key required");
    console.log(JSON.stringify(await repriceOpenRouter(store, Number(repo), id, secret.value, secret.managementKey, process.argv.includes("--apply")), null, 2));
  } finally { await db.close(); }
}
