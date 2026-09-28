import type { ArtifactStore } from "../artifacts/index.js";
import { executeTrial, RepeatSpendError, type RunnerOptions } from "./runner.js";
import { getEvaluation, initialEvaluation, saveEvaluation, updateEvaluation } from "./store.js";
import type { EvaluationInput } from "./types.js";

const INTERRUPTED = "Worker interrupted or timed out before this trial completed";

/**
 * Creates the record if needed and marks it running, returning how many trials it holds. A record
 * is started only while every trial is still queued, so no trial's model spend can be repeated.
 */
export async function startEvaluation(
  store: ArtifactStore,
  input: EvaluationInput,
): Promise<number> {
  if (!(await getEvaluation(store, input.repoId, input.id)))
    await saveEvaluation(store, initialEvaluation(input, input.modelName));
  const run = await updateEvaluation(store, input.repoId, input.id, (run) => {
    if (
      !["queued", "running"].includes(run.status) ||
      run.trials.some((trial) => trial.status !== "queued")
    )
      throw new RepeatSpendError();
    if (run.status === "running") return false;
    run.status = "running";
  });
  return run.trials.length;
}

/** Fails a trial whose activity ended without recording an outcome (a lost or timed-out worker). */
export async function failTrial(
  store: ArtifactStore,
  input: EvaluationInput,
  index: number,
): Promise<void> {
  await updateEvaluation(store, input.repoId, input.id, (run) => {
    const trial = run.trials[index];
    if (!trial || (trial.status !== "queued" && trial.status !== "running")) return false;
    trial.status = "failed";
    trial.error = INTERRUPTED;
    trial.finishedAt = new Date().toISOString();
  });
}

/** Records the evaluation's outcome once every trial has ended. */
export async function finishEvaluation(
  store: ArtifactStore,
  input: EvaluationInput,
): Promise<void> {
  await updateEvaluation(store, input.repoId, input.id, (run) => {
    if (run.status !== "running") return false;
    for (const trial of run.trials) {
      if (trial.status === "queued" || trial.status === "running") {
        trial.status = "failed";
        trial.error = "Not completed because the evaluation stopped";
      }
    }
    run.status = run.trials.some((trial) => trial.status === "failed") ? "failed" : "completed";
    run.finishedAt = new Date().toISOString();
  });
}

/** Fails an unfinished evaluation and every trial that has not recorded an outcome. */
export async function failEvaluation(
  store: ArtifactStore,
  input: EvaluationInput,
  error: string,
): Promise<void> {
  if (!(await getEvaluation(store, input.repoId, input.id))) return;
  await updateEvaluation(store, input.repoId, input.id, (run) => {
    if (run.status === "completed" || run.status === "failed") return false;
    run.status = "failed";
    run.error = error;
    run.finishedAt = new Date().toISOString();
    for (const trial of run.trials) {
      if (trial.status === "queued" || trial.status === "running") {
        trial.status = "failed";
        trial.error = "Evaluation interrupted before this trial completed";
      }
    }
  });
}

/**
 * Runs every trial in turn inside one activity. Only evaluations started before trials ran as
 * their own activities use it; see selfBenchEvaluationWorkflow.
 */
export async function executeEvaluation(
  store: ArtifactStore,
  input: EvaluationInput,
  options: RunnerOptions = {},
): Promise<void> {
  const trials = await startEvaluation(store, input);
  try {
    for (let index = 0; index < trials; index += 1) {
      options.signal?.throwIfAborted();
      await executeTrial(store, input, index, options);
    }
    await finishEvaluation(store, input);
  } catch (error) {
    await failEvaluation(
      store,
      input,
      error instanceof Error ? error.message : "Evaluation failed",
    );
  }
}
