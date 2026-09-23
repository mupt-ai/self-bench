import type { tasks } from "./schema.js";
import type { ReviewDecision, TaskRecord } from "./tasks.js";

/** A task row, with its reviewer and starter logins, as the record the app works with. */
export function taskFrom(row: {
  task: typeof tasks.$inferSelect;
  reviewedBy: string | null;
  startedBy: string | null;
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
    difficulty: task.difficulty,
    pipelineStatus: task.pipelineStatus,
    stage: task.stage,
    ...(task.round !== null ? { round: task.round } : {}),
    ...(task.reason ? { reason: task.reason } : {}),
    ...(task.bundleKey ? { bundleKey: task.bundleKey } : {}),
    ...(task.definition ? { definition: task.definition } : {}),
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
  };
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
