import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/index.js";
import { RepeatSpendError, updateEvaluation } from "./store.js";
import type { EvaluationInput, EvaluationRun, EvaluationTrial } from "./types.js";

/**
 * One attempt's hold on a trial in its evaluation record. An attempt claims the trial (queued to
 * running) under an id of its own and marks the claim solving just before Harbor starts. Until
 * then nothing has spent, so a later attempt may take over a claim whose worker was lost (a
 * preempted pod); after it, any other attempt refuses with RepeatSpendError. Every write checks
 * the claim is still this attempt's, so an attempt that lost it never overwrites the trial.
 */
export async function claimTrial(store: ArtifactStore, input: EvaluationInput, index: number) {
  const id = randomUUID();
  const update = (change: (run: EvaluationRun) => unknown) =>
    updateEvaluation(store, input.repoId, input.id, change);
  const run = await update((run) => {
    const trial = run.trials[index];
    const abandoned = trial?.status === "running" && !!trial.claim && !trial.solverStartedAt;
    if (run.status !== "running" || (trial?.status !== "queued" && !abandoned))
      throw new RepeatSpendError();
    trial.status = "running";
    trial.claim = id;
    trial.startedAt = new Date().toISOString();
  });
  // A trial finalized elsewhere (its evaluation failed, or it timed out) or taken over by another
  // attempt stays as it was left.
  const held = (latest: EvaluationRun) => {
    const current = latest.trials[index];
    return latest.status === "running" && current?.status === "running" && current.claim === id
      ? current
      : undefined;
  };
  return {
    run,
    trial: run.trials[index] as EvaluationTrial,
    /** Replaces the record's trial with `trial` while this attempt holds it. */
    save: (trial: EvaluationTrial) =>
      update((latest) => {
        if (!held(latest)) return false;
        latest.trials[index] = trial;
      }).then(() => undefined),
    /**
     * Marks the claim solving, or refuses if another attempt took it over. Both are saves of the
     * same record, so at most one attempt ever gets past this.
     */
    startSolver: async (): Promise<string> => {
      const startedAt = new Date().toISOString();
      await update((latest) => {
        const current = held(latest);
        if (!current) throw new RepeatSpendError();
        current.solverStartedAt = startedAt;
      });
      return startedAt;
    },
    /** Returns the trial to the queue, so the next attempt can claim it again. */
    requeue: () =>
      update((latest) => {
        const current = held(latest);
        if (!current) return false;
        current.status = "queued";
        delete current.startedAt;
        delete current.claim;
      }),
  };
}
