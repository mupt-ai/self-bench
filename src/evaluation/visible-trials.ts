import type { TaskStore } from "../db/tasks.js";
import { evaluationTaskKey } from "./models.js";
import type { EvaluationRun } from "./types.js";

/** Deleted tasks leave current results, but snapshots stay intact for published releases. */
export async function visibleTrials(
  tasks: TaskStore,
  repoId: number,
  runs: EvaluationRun[],
): Promise<{ runs: EvaluationRun[]; tag: string }> {
  const deleted = (await tasks.listWithDeleted(repoId)).filter((task) => task.deleted);
  const keys = new Set(deleted.map((task) => evaluationTaskKey(task.runId, task.taskId)));
  return {
    tag: deleted
      .map((task) => task.id)
      .sort((a, b) => a - b)
      .join("-"),
    runs: runs.map((run) => ({
      ...run,
      trials: run.trials.filter((trial) => !keys.has(evaluationTaskKey(trial.runId, trial.taskId))),
    })),
  };
}
