import type { ComparisonRecord } from "../db/comparisons.js";
import type { EvaluationRun } from "./types.js";

/** A comparison's progress, from each of its runs' records or summaries: `runs`, by run id. */
export function comparisonProgress(
  record: ComparisonRecord,
  runs: ReadonlyMap<string, EvaluationRun>,
) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    runs: record.inputs.map((input) => {
      const run = runs.get(input.id);
      return {
        id: input.id,
        model: input.modelName,
        thinking: input.thinking,
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
