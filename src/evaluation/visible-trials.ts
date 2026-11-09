import type { TaskStore } from "../db/tasks.js";
import { evaluationTaskKey } from "./models.js";
import type { EvaluationRun } from "./types.js";

/** Deleted tasks leave current results, but snapshots stay intact for published releases. */
export async function visibleTrials(
  tasks: TaskStore,
  repoId: number,
  runs: EvaluationRun[],
): Promise<{ runs: EvaluationRun[]; tag: string }> {
  const [everyTask, deletedVariants] = await Promise.all([
    tasks.listWithDeleted(repoId),
    tasks.variants.listDeleted(repoId),
  ]);
  const deleted = everyTask.filter((task) => task.deleted);
  const keys = new Set(
    [...deleted, ...deletedVariants].map((task) => evaluationTaskKey(task.runId, task.taskId)),
  );
  const ids = (rows: readonly { id: number }[]) =>
    rows
      .map((row) => row.id)
      .sort((a, b) => a - b)
      .join("-");
  return {
    // A deleted variant changes the view as a deleted task does.
    tag: deletedVariants.length ? `${ids(deleted)}.v${ids(deletedVariants)}` : ids(deleted),
    runs: runs.map((run) => ({
      ...run,
      trials: run.trials.filter((trial) => !keys.has(evaluationTaskKey(trial.runId, trial.taskId))),
    })),
  };
}
