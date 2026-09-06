import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../artifacts.js";
import type { EncryptedRecordStore } from "./encrypted-records.js";
import { executeEvaluation } from "./runner.js";
import { getEvaluation, initialEvaluation, saveEvaluation } from "./store.js";
import type { EvaluationInput } from "./types.js";

export interface EvaluationActivities {
  executeSolverEvaluation(input: EvaluationInput): Promise<void>;
  failSolverEvaluation(input: EvaluationInput): Promise<void>;
}
export function createEvaluationActivities(
  store: ArtifactStore,
  records?: EncryptedRecordStore,
): EvaluationActivities {
  return {
    async executeSolverEvaluation(input) {
      const context = Context.current();
      const timer = setInterval(() => context.heartbeat(), 10_000);
      try {
        if (input.credentials && !(await getEvaluation(store, input.repoId, input.id)))
          await saveEvaluation(store, initialEvaluation(input, input.modelName));
        await executeEvaluation(store, input, {
          ...(records ? { records } : {}),
          signal: context.cancellationSignal,
          heartbeat: () => context.heartbeat(),
        });
      } finally {
        clearInterval(timer);
      }
    },
    async failSolverEvaluation(input) {
      const run = await getEvaluation(store, input.repoId, input.id);
      if (!run || run.status === "completed" || run.status === "failed") return;
      run.status = "failed";
      run.error =
        "Worker interrupted or timed out. This evaluation will not retry automatically; sandbox cleanup may require operator verification.";
      run.finishedAt = new Date().toISOString();
      for (const trial of run.trials) {
        if (trial.status === "queued" || trial.status === "running") {
          trial.status = "failed";
          trial.error = "Evaluation interrupted before this trial completed";
        }
      }
      await saveEvaluation(store, run);
    },
  };
}
