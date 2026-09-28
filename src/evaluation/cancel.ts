import type { ArtifactStore } from "../artifacts/index.js";
import type { ComparisonRecord } from "../db/comparisons.js";
import { getEvaluation, initialEvaluation, saveEvaluation, updateEvaluation } from "./store.js";

/** Cancels the Temporal workflow that runs an evaluation; a finished or unknown one is ignored. */
export type StopEvaluation = (repoId: number, id: string) => Promise<void>;

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
  const run = await updateEvaluation(store, repoId, id, (run) => {
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
  });
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
    // A record for an unsubmitted run keeps a later resume from starting it.
    if (!(await getEvaluation(store, record.repoId, input.id)))
      await saveEvaluation(store, initialEvaluation(input, input.modelName));
    await cancelEvaluation(store, record.repoId, input.id, login, stop);
  }
}
