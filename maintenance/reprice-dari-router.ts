import { isDeepStrictEqual } from "node:util";
import { type ArtifactStore, createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { dariTrialCost, isDariRun } from "../src/evaluation/dari/cost.js";
import { getEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { storedHarborFiles } from "./recompute-cost.js";

/** Restore prices only from complete response evidence already retained by a finished run. */
export async function repriceDariRouter(
  store: ArtifactStore,
  repoId: number,
  id: string,
  apply: boolean,
) {
  const run = await getEvaluation(store, { repoId: repoId }, id);
  if (!run || !isDariRun(run)) throw new Error("Dari router evaluation not found");
  if (run.status === "running" || run.status === "queued") throw new Error("Evaluation is still in progress");
  const trials = [];
  for (const [index, trial] of run.trials.entries()) {
    if (trial.status !== "completed") {
      trials.push({ index, taskId: trial.taskId, after: {}, changed: false });
      continue;
    }
    const { files } = await storedHarborFiles(store, run, trial);
    const after = await dariTrialCost(run, trial, {}, files);
    const before = { apiCostUsd: trial.apiCostUsd, costSource: trial.costSource, modelVerified: trial.modelVerified, ...(trial.costIncomplete ? { costIncomplete: true as const } : {}) };
    const changed = after.apiCostUsd !== undefined && !isDeepStrictEqual(before, after);
    trials.push({ index, taskId: trial.taskId, before, after, changed });
    if (changed) {
      Object.assign(trial, after);
      if (!after.costIncomplete) delete trial.costIncomplete;
    }
  }
  const applied = apply && trials.some((trial) => trial.changed);
  if (applied) await saveEvaluation(store, run);
  return { trials, applied };
}

export async function main() {
  const [repo, id] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!repo || !/^\d+$/.test(repo) || !id) throw new Error("Usage: reprice-dari-router.js <repoId> <evaluationId> [--apply]");
  const store = createArtifactStore(loadConfig().artifact);
  const report = await repriceDariRouter(store, Number(repo), id, process.argv.includes("--apply"));
  console.log(JSON.stringify(report, null, 2));
}
