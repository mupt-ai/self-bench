import { type BatchStatus, batchIsTerminal } from "../batch-api";

export type BatchTask = NonNullable<BatchStatus["tasks"]>[number];
export const activityLabels = {
  running: "Running",
  queued: "Queued",
  unknown: "Activity Unknown",
  accepted: "Verified",
  rejected: "Rejected",
  infrastructure_failed: "Failed",
  stopped: "Stopped",
} as const;
export type TaskActivity = keyof typeof activityLabels;

/** A workflow stage is not proof that its worker is currently executing. */
export function taskActivity(status: BatchStatus, task: BatchTask): TaskActivity {
  if (
    task.status === "accepted" ||
    task.status === "rejected" ||
    task.status === "infrastructure_failed"
  )
    return task.status;
  if (batchIsTerminal(status.phase)) return "stopped";
  if (task.status === "queued") return "queued";
  return status.activity?.[task.candidateId]?.state ?? "unknown";
}

export function activityCounts(status: BatchStatus) {
  const counts: Record<TaskActivity, number> = {
    running: 0,
    queued: 0,
    unknown: 0,
    accepted: 0,
    rejected: 0,
    infrastructure_failed: 0,
    stopped: 0,
  };
  for (const task of status.tasks ?? []) counts[taskActivity(status, task)]++;
  return counts;
}

/** The round prefix repeats the row's Stage column; the rest is what actually went wrong. */
const failureCause = (failure: string) => failure.replace(/^(authoring|review) round \d+:\s*/, "");

/** "Attempt 3 of 4 · <failure>" for a candidate whose previous attempt failed. */
export function retryDetail(status: BatchStatus, task: BatchTask): string | undefined {
  const detail = status.activity?.[task.candidateId];
  if (!detail?.lastFailure) return undefined;
  const attempt =
    detail.attempt !== undefined
      ? `Attempt ${detail.attempt}${detail.maximumAttempts ? ` of ${detail.maximumAttempts}` : ""} · `
      : "";
  return `${attempt}${failureCause(detail.lastFailure)}`;
}

const REPEATED_FAILURE_THRESHOLD = 3;

/** The failure most in-flight candidates are retrying, when enough share it to suggest one cause. */
export function repeatedFailure(
  status: BatchStatus,
): { count: number; failure: string } | undefined {
  if (batchIsTerminal(status.phase)) return undefined;
  const counts = new Map<string, number>();
  for (const task of status.tasks ?? []) {
    if (taskActivity(status, task) === "running" || taskActivity(status, task) === "queued") {
      const failure = status.activity?.[task.candidateId]?.lastFailure;
      if (failure) {
        const cause = failureCause(failure);
        counts.set(cause, (counts.get(cause) ?? 0) + 1);
      }
    }
  }
  let top: { count: number; failure: string } | undefined;
  for (const [failure, count] of counts) if (!top || count > top.count) top = { count, failure };
  return top && top.count >= REPEATED_FAILURE_THRESHOLD ? top : undefined;
}
