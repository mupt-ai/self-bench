import { defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import { task } from "../../temporal/activity-options.js";
import type { TaskImageActivities } from "./task-images-activity.js";

/** Sent by the API after a task's review changes or the task is deleted. */
export const taskReviewChanged = defineSignal("taskReviewChanged");

/** The workflow ID that serializes one task row's image changes. */
export function taskImagesWorkflowId(taskRowId: number): string {
  return `task-images/${taskRowId}`;
}

const images = proxyActivities<TaskImageActivities>(task({ timeout: "5 minutes", attempts: 5 }));

/**
 * Keeps one task's images in step with its human review: removes them once a person rejects or
 * deletes the task, unless something pins them. A review that changes while a removal runs is
 * reconciled again afterwards, against the row as it is then.
 */
export async function selfBenchTaskImagesWorkflow(taskRowId: number): Promise<void> {
  let changed = true;
  setHandler(taskReviewChanged, () => {
    changed = true;
  });
  while (changed) {
    changed = false;
    await images.reconcileTaskImages(taskRowId);
  }
}
