import type { ArtifactStore } from "../artifacts/index.js";
import type { ComparisonRecord } from "../db/comparisons.js";
import { getEvaluation, initialEvaluation, saveEvaluation, updateEvaluation } from "./store.js";
import type { EvaluationRun } from "./types.js";

/** Cancels the Temporal workflow that runs an evaluation; a finished or unknown one is ignored. */
export type StopEvaluation = (repoId: number, id: string) => Promise<void>;

/** Fails an unfinished run and its unfinished trials; returns false for a finished run. */
function markCancelled(run: EvaluationRun, login: string): boolean {
  if (run.status === "completed" || run.status === "failed") return false;
  const now = new Date().toISOString();
  run.status = "failed";
  run.error = `Cancelled by ${login}.`;
  run.finishedAt = now;
  for (const trial of run.trials) {
    if (trial.status === "queued" || trial.status === "running") {
      trial.status = "failed";
      trial.error = "Cancelled before this trial completed";
      trial.finishedAt = now;
    }
  }
  return true;
}

/**
 * Stops an unfinished evaluation. The record is failed first, so no trial can claim a start after
 * this and the running trials' later saves are dropped; cancelling the workflow then aborts the
 * Harbor processes still running. The workflow is cancelled on every request, not only the first,
 * so a retry still stops it when an earlier cancellation reached the record but not Temporal.
 */
export async function cancelEvaluation(
  store: ArtifactStore,
  repoId: number,
  id: string,
  login: string,
  stop: StopEvaluation,
): Promise<void> {
  const run = await updateEvaluation(store, repoId, id, (run) => markCancelled(run, login));
  if (run.status !== "completed") await stop(repoId, id);
}

/** Cancels every unfinished run of a comparison, including runs never submitted. */
export async function cancelComparison(
  store: ArtifactStore,
  record: ComparisonRecord,
  login: string,
  stop: StopEvaluation,
): Promise<void> {
  for (const input of record.inputs) {
    // An unsubmitted run's first record is written already cancelled, so a resume racing this
    // never sees it queued. If a start wrote that record first, the update below cancels it.
    if (!(await getEvaluation(store, record.repoId, input.id))) {
      const run = initialEvaluation(input, input.modelName);
      markCancelled(run, login);
      await saveEvaluation(store, run).catch(() => undefined);
    }
    await cancelEvaluation(store, record.repoId, input.id, login, stop);
  }
}
