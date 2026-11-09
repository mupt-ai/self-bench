import type { tasks } from "./schema.js";
import type { ReviewDecision, TaskRecord } from "./tasks.js";

/** A task row, with its reviewer and starter logins, as the record the app works with. */
export function taskFrom(row: {
  task: typeof tasks.$inferSelect;
  reviewedBy: string | null;
  startedBy: string | null;
  origin: { runId: string; taskId: string } | null;
}): TaskRecord {
  const { task } = row;
  return {
    id: task.id,
    repoId: task.repoId,
    runId: task.runId,
    candidateId: task.candidateId,
    taskId: task.taskId,
    ...(task.sourcePr !== null ? { sourcePr: task.sourcePr } : {}),
    ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
    ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}),
    ...(task.title ? { title: task.title } : {}),
    difficulty: task.difficulty,
    pipelineStatus: task.pipelineStatus,
    stage: task.stage,
    ...(task.round !== null ? { round: task.round } : {}),
    ...(task.reason ? { reason: task.reason } : {}),
    ...(task.bundleKey ? { bundleKey: task.bundleKey } : {}),
    ...(task.images ? { images: task.images } : {}),
    ...(task.reviewDecision
      ? {
          review: {
            decision: task.reviewDecision,
            note: task.reviewNote ?? "",
            decidedBy: row.reviewedBy ?? "",
            decidedAt: (task.reviewedAt ?? new Date(0)).toISOString(),
          },
        }
      : {}),
    syncedAt: task.syncedAt.toISOString(),
    ...(task.workflowId ? { workflowId: task.workflowId } : {}),
    ...(row.startedBy ? { startedBy: row.startedBy } : {}),
    ...(task.startedAt ? { startedAt: task.startedAt.toISOString() } : {}),
    ...(row.origin ? { revisedFrom: row.origin } : {}),
    ...(task.feedback ? { feedback: task.feedback } : {}),
    ...(task.variant ? { variant: task.variant } : {}),
  };
}

/**
 * A variant (generation/tasks/variant.ts) changes an accepted task's environment and is not a task
 * of its own: it stays out of task lists, counts, and the results a repository's tasks are scored on.
 */
export function isVariant(task: Pick<TaskRecord, "variant">): boolean {
  return task.variant !== undefined;
}

/** How a task stands after the pipeline and, when present, a human. */
export type TaskState =
  | "needs_review"
  | "accepted"
  | "rejected"
  | "failed"
  | "cancelled"
  | "in_progress";

/** Pipeline verdict first, then the human's: a review overrides whatever the run concluded. */
export function taskState(
  task: Pick<TaskRecord, "pipelineStatus"> & {
    stage?: string;
    review?: { decision: ReviewDecision };
  },
): TaskState {
  if (task.stage === "cancelled") return "cancelled";
  if (task.review) return task.review.decision === "approve" ? "accepted" : "rejected";
  switch (task.pipelineStatus) {
    case "accepted":
      return "needs_review";
    case "rejected":
      return "rejected";
    case "infrastructure_failed":
      return "failed";
    default:
      return "in_progress";
  }
}

/**
 * Accepted by the pipeline, bundled, and approved by a human: the only tasks a comparison may
 * run and a release may publish.
 */
export function runnable(
  task: Pick<TaskRecord, "bundleKey" | "pipelineStatus" | "review">,
): boolean {
  return (
    !!task.bundleKey && task.pipelineStatus === "accepted" && task.review?.decision === "approve"
  );
}
