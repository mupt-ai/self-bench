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
  return status.activity?.[task.candidateId] ?? "unknown";
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
