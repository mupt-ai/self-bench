import { ApplicationFailure } from "@temporalio/common";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { CandidateWorkflowResult, TaskProgress } from "../../contracts/index.js";
import type { TaskRecord, TaskStore } from "../../db/tasks.js";
import { acceptedTaskFields } from "./rows.js";

/** The row a candidate workflow owns: one candidate of one run. */
interface TaskRow {
  readonly runId: string;
  readonly candidateId: string;
}

/**
 * The candidate workflow's writes to its task row. A candidate without a row (a batch outside any
 * connected repository) writes nothing.
 */
export interface TaskActivities {
  recordTaskProgress(input: TaskRow & { readonly progress: TaskProgress }): Promise<void>;
  /** The candidate's verdict; `cancelled` when a person or its batch stopped it. */
  settleTask(
    input: TaskRow & { readonly result: CandidateWorkflowResult; readonly cancelled?: boolean },
  ): Promise<void>;
}

export function createTaskActivities(options: {
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
}): TaskActivities {
  const { tasks, artifacts } = options;
  return {
    async recordTaskProgress({ runId, candidateId, progress }) {
      await tasks.progress(runId, candidateId, {
        stage: progress.status,
        ...(progress.round !== undefined ? { round: progress.round } : {}),
        ...(progress.taskId !== candidateId ? { taskId: progress.taskId } : {}),
      });
    },
    async settleTask({ runId, candidateId, result, cancelled }) {
      const { progress, task } = result;
      const status = progress.status;
      if (status !== "accepted" && status !== "rejected" && status !== "infrastructure_failed")
        throw ApplicationFailure.nonRetryable(`candidate ${candidateId} settled while ${status}`);
      await tasks.settle(runId, candidateId, {
        pipelineStatus: status,
        stage: cancelled
          ? "cancelled"
          : status === "accepted"
            ? "accepted"
            : (progress.stage ?? "authoring"),
        ...(progress.round !== undefined ? { round: progress.round } : {}),
        ...(progress.taskId !== candidateId ? { taskId: progress.taskId } : {}),
        ...(progress.reason
          ? { reason: cancelled ? progress.reason : verdictReason(status, progress.reason) }
          : {}),
        ...(status === "accepted" && task ? await acceptedTaskFields(artifacts, task) : {}),
      });
    },
  };
}

/** How the batch page shows a candidate from its row. */
export function rowProgress(row: TaskRecord): TaskProgress {
  const running = ["queued", "authoring", "verifying", "reviewing"] as const;
  const status =
    row.pipelineStatus === "in_progress"
      ? (running.find((stage) => stage === row.stage) ?? "authoring")
      : row.pipelineStatus;
  return {
    candidateId: row.candidateId,
    taskId: row.taskId,
    difficulty: row.difficulty,
    status,
    ...(row.round !== undefined ? { round: row.round } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

function verdictReason(status: TaskProgress["status"], reason: string): string {
  if (status !== "infrastructure_failed") return reason;
  return `${infrastructureFailureSummary(reason)}\n\nTechnical details: ${reason}`;
}

export function infrastructureFailureSummary(reason: string): string {
  if (/client_email|GoogleAuth|sign data/i.test(reason)) {
    return "Run Failed: artifact storage credentials are incomplete. Ask an administrator to configure the worker's Google Cloud service account.";
  }
  if (/could not find package\.json above/i.test(reason)) {
    return "Run Failed: the worker was running from an unavailable checkout. Restart the worker from the active SelfBench checkout.";
  }
  if (/timed out|timeout/i.test(reason)) {
    return "Run Failed: the agent or worker timed out before this stage completed.";
  }
  const first = reason
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  return `Run Failed: ${first?.slice(0, 240) ?? "the worker encountered an infrastructure error."}`;
}
