import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
  defineSignal,
  executeChild,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import { harbor, task } from "../../temporal/activity-options.js";
import { whenSandboxFree } from "../../temporal/sandbox-capacity.js";
import type { ConversionOutcome } from "./task-conversion.js";
import type { RebuildOutcome } from "./task-image-rebuild.js";
import type { TaskImageOutcome } from "./task-images.js";
import type { TaskImageActivities, TaskImageRebuildActivities } from "./task-images-activity.js";

/** Sent by the API after a task's review changes or the task is deleted. */
export const taskReviewChanged = defineSignal("taskReviewChanged");

/** The workflow ID that serializes one task row's image changes. */
export function taskImagesWorkflowId(taskRowId: number): string {
  return `task-images/${taskRowId}`;
}

/** The workflow ID that serializes one task row's conversion. */
function taskConversionWorkflowId(taskRowId: number): string {
  return `task-conversion/${taskRowId}`;
}

const images = proxyActivities<TaskImageActivities>(task({ timeout: "5 minutes", attempts: 5 }));
// A rebuild is a check: both image builds, then Harbor's smoke, nop and oracle runs.
const rebuilding = () =>
  proxyActivities<TaskImageRebuildActivities>(
    harbor({ timeout: "7 hours", attempts: 3, heartbeat: "10 minutes" }),
  );

/**
 * Keeps one task's images in step with its review. A person rejecting or deleting the task removes
 * them, unless something pins them; a kept task without them (accepted before images were built,
 * or approved again after a rejection removed them) is rebuilt and checked again. A review that
 * changes meanwhile is reconciled again afterwards, against the row as it is then.
 */
export async function selfBenchTaskImagesWorkflow(
  taskRowId: number,
): Promise<TaskImageOutcome | RebuildOutcome> {
  let changed = true;
  setHandler(taskReviewChanged, () => {
    changed = true;
  });
  let outcome: TaskImageOutcome | RebuildOutcome = { status: "skipped", reason: "Not reconciled" };
  while (changed) {
    changed = false;
    outcome = await images.reconcileTaskImages(taskRowId);
    if (outcome.status === "unbuilt")
      outcome = await whenSandboxFree(() => rebuilding().rebuildTaskImages(taskRowId));
  }
  return outcome;
}

/** Which tasks a backfill covers, and how many it works on at once. */
interface TaskBackfill {
  /** Every task it applies to in these repositories, or in all when left out. */
  readonly repoIds?: readonly number[];
  /** Exactly these task rows instead, for a pilot. */
  readonly rowIds?: readonly number[];
  readonly concurrency?: number;
  /** Lists the rows without changing anything. */
  readonly dryRun?: boolean;
}

interface BackfillResult {
  readonly rows: number[];
  readonly outcomes: Record<number, string>;
}

/**
 * An operator's one-off: gives every kept task that runs on its Dockerfiles the images new tasks
 * get, by running each row's selfBenchTaskImagesWorkflow, a few at a time, on the normal workers.
 * Returns each row's outcome; a row whose workflow is already running reports so and is left to it.
 * Operators start it by name (maintenance/README.md), so nothing in the code calls it.
 *
 * @public
 */
export async function selfBenchTaskImagesBackfillWorkflow(
  input: TaskBackfill,
): Promise<BackfillResult> {
  const rows = input.rowIds ? [...input.rowIds] : await images.tasksWithoutImages(input.repoIds);
  return await backfill(rows, input, async (row) => {
    try {
      const outcome = await executeChild(selfBenchTaskImagesWorkflow, {
        workflowId: taskImagesWorkflowId(row),
        args: [row],
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
      return "gate" in outcome ? `${outcome.status} at ${outcome.gate}` : outcome.status;
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) return "already running";
      throw error;
    }
  });
}

/**
 * An operator's one-off: converts every kept task still authored as definition.json to native
 * files (task-conversion.ts), a few at a time. A row takes its converted bundle and images only if
 * every gate passes; one the conversion cannot write is reported `unconvertible` with why, for an
 * author to revise. Operators start it by name (maintenance/README.md).
 *
 * @public
 */
export async function selfBenchTaskConversionBackfillWorkflow(
  input: TaskBackfill,
): Promise<BackfillResult> {
  const rows = input.rowIds ? [...input.rowIds] : await images.legacyTasks(input.repoIds);
  return await backfill(rows, input, async (row) => {
    try {
      const outcome = await executeChild(selfBenchTaskConversionWorkflow, {
        workflowId: taskConversionWorkflowId(row),
        args: [row],
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
      if ("gate" in outcome) return `${outcome.status} at ${outcome.gate}`;
      return "reason" in outcome ? `${outcome.status}: ${outcome.reason}` : outcome.status;
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) return "already running";
      throw error;
    }
  });
}

/**
 * One task's conversion, alone on its own workflow ID so a retry or a second backfill never runs
 * a second conversion of the same row: the two would build under the same image names, and the
 * loser's cleanup would be the winner's images to delete.
 *
 * @public
 */
export async function selfBenchTaskConversionWorkflow(
  taskRowId: number,
): Promise<ConversionOutcome> {
  return await whenSandboxFree(() => rebuilding().convertTask(taskRowId));
}

/** Runs `step` on each row, `concurrency` at a time; a step that throws reports its error. */
async function backfill(
  rows: number[],
  input: TaskBackfill,
  step: (row: number) => Promise<string>,
): Promise<BackfillResult> {
  const outcomes: Record<number, string> = {};
  if (input.dryRun) return { rows, outcomes };
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const row = rows[next++] as number;
      outcomes[row] = await step(row).catch(
        (error) => `error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, input.concurrency ?? 4) }, lane));
  return { rows, outcomes };
}
