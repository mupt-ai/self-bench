/**
 * Re-derives trial cost fields from a finished evaluation's stored Harbor artifacts, for runs
 * recorded before a cost fix shipped.
 *
 *   node dist/evaluation/recompute-cost.js <repoId> <evaluationId>           # dry run
 *   node dist/evaluation/recompute-cost.js <repoId> <evaluationId> --apply   # save a snapshot
 *
 * Reads the artifact store from the usual SELFBENCH_ARTIFACT_* / SELFBENCH_GCS_* settings. Apply
 * appends a new snapshot and never rewrites old ones, so the previous revision stays readable.
 * Only the cost fields change. See docs/operations.md.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { type ArtifactStore, createArtifactStore } from "../artifacts/index.js";
import { loadConfig } from "../contracts/config/index.js";
import { trialCost } from "./cost.js";
import { record } from "./output.js";
import { evaluationPrefix, getEvaluation, saveEvaluation } from "./store.js";
import type { EvaluationTrial } from "./types.js";

type CostFields = Pick<
  EvaluationTrial,
  "modelVerified" | "apiCostUsd" | "tokenUsage" | "costSource"
>;
const costKeys = ["modelVerified", "apiCostUsd", "tokenUsage", "costSource"] as const;

interface RecomputeReport {
  status: string;
  trials: { index: number; before: CostFields; after?: CostFields; changed: boolean }[];
  applied: boolean;
}

const costFields = (trial: CostFields): CostFields =>
  Object.fromEntries(
    costKeys.flatMap((key) => (trial[key] === undefined ? [] : [[key, trial[key]]])),
  );

export async function recomputeEvaluationCost(
  store: ArtifactStore,
  repoId: number,
  id: string,
  apply: boolean,
): Promise<RecomputeReport> {
  const run = await getEvaluation(store, repoId, id);
  if (!run) throw new Error("Evaluation not found");
  if (run.status === "queued" || run.status === "running")
    throw new Error("Evaluation is still in progress");
  const report: RecomputeReport = { status: run.status, trials: [], applied: false };
  for (const [index, trial] of run.trials.entries()) {
    const before = costFields(trial);
    const names = trial.artifacts.filter((name) =>
      /\/(trajectory\.json|pi\.txt|result\.json)$/.test(name),
    );
    const files = new Map<string, string>();
    for (const name of names) {
      const bytes = await store.getByKey(`${evaluationPrefix(repoId, id)}artifacts/${name}`);
      if (bytes) files.set(name.slice(name.indexOf("/") + 1), Buffer.from(bytes).toString("utf8"));
    }
    const result = [...files].find(([name]) => /^solver\/[^/]+\/result\.json$/.test(name));
    if (!result) {
      report.trials.push({ index, before, changed: false });
      continue;
    }
    const after = trialCost(run, trial.harness, files, record(JSON.parse(result[1])));
    const changed = !isDeepStrictEqual(before, after);
    report.trials.push({ index, before, after, changed });
    if (changed) {
      for (const key of costKeys) delete trial[key];
      Object.assign(trial, after);
    }
  }
  if (apply && report.trials.some((trial) => trial.changed)) {
    await saveEvaluation(store, run);
    report.applied = true;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repoId, id] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!repoId || !/^\d+$/.test(repoId) || !id)
    throw new Error("Usage: recompute-cost.js <repoId> <evaluationId> [--apply]");
  const store = createArtifactStore(loadConfig().artifact);
  const report = await recomputeEvaluationCost(
    store,
    Number(repoId),
    id,
    process.argv.includes("--apply"),
  );
  console.log(JSON.stringify(report, null, 2));
}
