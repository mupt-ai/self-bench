import type { Client } from "@temporalio/client";
import { queryStatus } from "../api/status.js";
import type { BatchStatus, TaskActivityDetail } from "./batch-progress.js";

const PENDING_ACTIVITY_SCHEDULED = 1;
const PENDING_ACTIVITY_STARTED = 2;

interface ProtoTimestamp {
  seconds?: number | { toNumber(): number } | null;
  nanos?: number | null;
}
interface PendingActivity {
  state?: number | null;
  attempt?: number | null;
  maximumAttempts?: number | null;
  activityType?: { name?: string | null } | null;
  lastFailure?: { message?: string | null } | null;
  nextAttemptScheduleTime?: ProtoTimestamp | null;
}

/** Workflow stages describe intent; pending activities distinguish execution from queueing. */
export async function liveBatchStatus(client: Client, runId: string): Promise<BatchStatus> {
  const status = (await queryStatus(client.workflow.getHandle(runId))) as BatchStatus;
  return overlayCandidateActivity(client, status);
}

/**
 * Reads each in-flight candidate's pending activity from Temporal so the page can tell a
 * candidate that is executing from one waiting on a retry, and can show what failed last.
 */
export async function overlayCandidateActivity(
  client: Client,
  status: BatchStatus,
): Promise<BatchStatus> {
  if (["complete", "failed", "blocked", "cancelled"].includes(status.phase)) return status;
  const tasks = (status.tasks ?? []).filter((task) =>
    ["authoring", "verifying", "reviewing"].includes(task.status),
  );
  const activity: NonNullable<BatchStatus["activity"]> = {};
  const markUnknown = () => {
    for (const task of tasks.slice(0, 100)) {
      if (!activity[task.candidateId]) activity[task.candidateId] = { state: "unknown" };
    }
  };
  try {
    // Same 10s budget as other batch Temporal calls so one hung describe cannot stall the poll.
    await client.connection.withDeadline(Date.now() + 10_000, async () => {
      // Generation admits at most 100 candidate workflows concurrently; limit each refresh's reads.
      for (let index = 0; index < Math.min(tasks.length, 100); index += 8) {
        await Promise.all(
          tasks.slice(index, Math.min(index + 8, 100)).map(async (task) => {
            try {
              const description = await client.workflowService.describeWorkflowExecution({
                namespace: client.options.namespace,
                execution: { workflowId: `${status.runId}/candidate/${task.candidateId}` },
              });
              activity[task.candidateId] = activityDetail(description.pendingActivities ?? []);
            } catch {
              activity[task.candidateId] = { state: "unknown" };
            }
          }),
        );
      }
    });
  } catch {
    markUnknown();
  }
  return { ...status, activity };
}

export function activityDetail(pending: readonly PendingActivity[]): TaskActivityDetail {
  const current =
    pending.find((entry) => entry.state === PENDING_ACTIVITY_STARTED) ??
    pending.find((entry) => entry.state === PENDING_ACTIVITY_SCHEDULED);
  if (!current) return { state: "unknown" };
  const detail: TaskActivityDetail = {
    state: current.state === PENDING_ACTIVITY_STARTED ? "running" : "queued",
  };
  if (current.activityType?.name) detail.activityType = current.activityType.name;
  if (current.attempt) detail.attempt = current.attempt;
  if (current.maximumAttempts) detail.maximumAttempts = current.maximumAttempts;
  const failure = normalizeFailure(current.lastFailure?.message);
  if (failure) detail.lastFailure = failure;
  const next = timestampToIso(current.nextAttemptScheduleTime);
  if (next) detail.nextAttemptAt = next;
  return detail;
}

/** Strips the per-attempt artifact reference so identical provider errors compare equal. */
export function normalizeFailure(message: string | null | undefined): string | undefined {
  const text = message?.replace(/;\s*(partial )?log:\s*\S+/g, "").trim();
  return text ? text : undefined;
}

function timestampToIso(timestamp: ProtoTimestamp | null | undefined): string | undefined {
  if (!timestamp?.seconds) return undefined;
  const seconds =
    typeof timestamp.seconds === "number" ? timestamp.seconds : timestamp.seconds.toNumber();
  return new Date(seconds * 1_000 + Math.floor((timestamp.nanos ?? 0) / 1_000_000)).toISOString();
}
