import { defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type { TaskImageActivities } from "./task-images-activity.js";

/** Sent by the API after a task's review changes or the task is deleted. */
export const taskReviewChanged = defineSignal("taskReviewChanged");

/** The workflow ID that serializes one task row's image changes. */
export function taskImagesWorkflowId(taskRowId: number): string {
  return `task-images/${taskRowId}`;
}

// Exporting a large task's images streams its whole filesystem out of the provider.
const harbor = () =>
  proxyActivities<TaskImageActivities>({
    startToCloseTimeout: "3 hours",
    heartbeatTimeout: "10 minutes",
    retry: {
      initialInterval: "1 minute",
      backoffCoefficient: 2,
      maximumInterval: "30 minutes",
      maximumAttempts: 5,
    },
    taskQueue: `${workflowInfo().taskQueue}-harbor`,
  });

/**
 * Keeps one task's exported images in step with its human review: exports them once a person
 * approves the task, removes them once a person rejects or deletes it. Reviews that change while
 * an export or removal runs are reconciled again afterwards, against the row as it is then.
 */
export async function selfBenchTaskImagesWorkflow(taskRowId: number): Promise<void> {
  let changed = true;
  setHandler(taskReviewChanged, () => {
    changed = true;
  });
  while (changed) {
    changed = false;
    await harbor().reconcileTaskImages(taskRowId);
  }
}
