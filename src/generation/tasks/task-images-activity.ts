import type { ArtifactStore } from "../../artifacts/index.js";
import type { Database } from "../../db/client.js";
import { type TaskImageOutcome, taskImageReconciler, taskImageRows } from "./task-images.js";

export interface TaskImageActivities {
  reconcileTaskImages(taskRowId: number): Promise<TaskImageOutcome>;
}

/** The activity behind selfBenchTaskImagesWorkflow, on the workflow queue: a few registry calls. */
export function createTaskImageActivities(options: {
  readonly db: Database;
  readonly store: ArtifactStore;
}): TaskImageActivities {
  const rows = taskImageRows(options.db);
  const reconcile = taskImageReconciler(options);
  return {
    async reconcileTaskImages(taskRowId) {
      const task = await rows.find(taskRowId);
      if (!task) return { status: "skipped", reason: "Task row is gone" };
      const outcome = await reconcile(task);
      console.log(
        JSON.stringify({ event: "task-images", taskRowId, taskId: task.taskId, ...outcome }),
      );
      return outcome;
    },
  };
}
