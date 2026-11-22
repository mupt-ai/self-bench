import type { RunBatchRecord } from "../db/run-batches.js";
import type { EvaluationRun } from "./types.js";

/** A batch's progress, from each of its runs' records or summaries: `runs`, by run id. */
export function runBatchProgress(record: RunBatchRecord, runs: ReadonlyMap<string, EvaluationRun>) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    runs: record.inputs.map((input) => {
      const run = runs.get(input.id);
      return {
        id: input.id,
        model: input.modelName,
        thinking: input.thinking,
        ...(input.subagent ? { subagent: input.subagent.model } : {}),
        ...(input.condition ? { condition: input.condition.name } : {}),
        harnesses: input.harnesses,
        status: run?.status ?? "pending",
        completed:
          run?.trials.filter((trial) => trial.status === "completed" || trial.status === "failed")
            .length ?? 0,
        trials: input.tasks.length * input.harnesses.length,
      };
    }),
  };
}
