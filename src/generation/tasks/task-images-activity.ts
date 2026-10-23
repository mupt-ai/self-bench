import type { ArtifactStore } from "../../artifacts/index.js";
import type { Database } from "../../db/client.js";
import type { Vault } from "../../db/vault.js";
import { withHeartbeats } from "../pipeline/helpers.js";
import { type TaskImageOutcome, taskImageReconciler, taskImageRows } from "./task-images.js";

export interface TaskImageActivities {
  reconcileTaskImages(taskRowId: number): Promise<TaskImageOutcome>;
}

/** The Harbor-queue activity behind selfBenchTaskImagesWorkflow. */
export function createTaskImageActivities(options: {
  readonly db: Database;
  readonly vault: Pick<Vault, "records" | "credentials">;
  readonly store: ArtifactStore;
  readonly repository: string;
}): TaskImageActivities {
  const rows = taskImageRows(options.db);
  const reconcile = taskImageReconciler(options);
  return {
    async reconcileTaskImages(taskRowId) {
      const task = await rows.find(taskRowId);
      if (!task) return { status: "skipped", reason: "Task row is gone" };
      const outcome = await withHeartbeats(`reconciling ${task.taskId}'s images`, (signal) =>
        reconcile(task, true, signal),
      );
      console.log(
        JSON.stringify({ event: "task-images", taskRowId, taskId: task.taskId, ...outcome }),
      );
      return outcome;
    },
  };
}
