import { defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import { harborQueue, task } from "../../temporal/activity-options.js";
import type { TaskImageActivities } from "./task-images-activity.js";

/** Sent by the API after a task's review changes or the task is deleted. */
export const taskReviewChanged = defineSignal("taskReviewChanged");

/** The workflow ID that serializes one task row's image changes. */
export function taskImagesWorkflowId(taskRowId: number): string {
  return `task-images/${taskRowId}`;
}

/**
 * The queue exports and removals run on, beside `<queue>-harbor`. Its workers take only a few at a
 * time (TASK_IMAGE_CONCURRENCY), so a burst of approvals waits in Temporal, where no timeout or
 * retry runs, instead of starving each other's downloads past E2B's one-hour sandbox lifetime.
 */
export function taskImageQueue(taskQueue: string): string {
  return `${harborQueue(taskQueue)}-images`;
}

/** Exports one worker runs at once: each streams and hashes a whole filesystem. */
export const TASK_IMAGE_CONCURRENCY = 2;

// Exporting a large task's images streams its whole filesystem out of the provider.
const images = () =>
  proxyActivities<TaskImageActivities>({
    ...task({ timeout: "3 hours", attempts: 5, heartbeat: "10 minutes" }),
    taskQueue: taskImageQueue(workflowInfo().taskQueue),
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
    await images().reconcileTaskImages(taskRowId);
  }
}
