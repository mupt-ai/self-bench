import type { ArtifactStore } from "../../artifacts/index.js";
import type { RunPhase, RunStatus } from "../../contracts/index.js";
import type { ConnectedRepo } from "../../db/repos.js";
import type { TaskStore, TaskUpsert } from "../../db/tasks.js";
import type { SandboxCostSnapshot } from "../../sandbox/contracts.js";
import { acceptedTaskFields, pipelineStatus } from "../tasks/rows.js";
import type { GenerationBatch } from "./types.js";

/** What the Temporal server reports about a candidate's current activity attempt. */
export interface TaskActivityDetail {
  state: "running" | "queued" | "unknown";
  activityType?: string;
  attempt?: number;
  maximumAttempts?: number;
  /** The previous attempt's failure, without its artifact log reference. */
  lastFailure?: string;
  /** ISO time of the next retry, while the activity waits on backoff. */
  nextAttemptAt?: string;
  cost?: SandboxCostSnapshot;
}
export type BatchStatus = Pick<RunStatus, "runId" | "phase"> &
  Partial<Omit<RunStatus, "runId" | "phase">> & {
    activity?: Record<string, TaskActivityDetail>;
  };
const terminalBatch = (phase: RunPhase): boolean =>
  ["complete", "failed", "blocked", "cancelled"].includes(phase);

/**
 * Writes one task row per candidate straight from the batch record: live progress while it
 * runs, the verdict when it ends, and the accepted bundle and definition. Reviews are untouched.
 */
export async function syncBatchProgress(options: {
  repo: ConnectedRepo;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  batch: GenerationBatch;
  status: BatchStatus;
}): Promise<void> {
  const { repo, tasks, artifacts, batch, status } = options;
  const existing = await tasks.listForRepo(repo.id);
  const interrupted = terminalBatch(status.phase);
  const rows: TaskUpsert[] = [];
  for (const item of batch.candidates) {
    const { candidate } = item;
    const progress =
      status.tasks?.find((task) => task.candidateId === candidate.candidateId) ?? item.progress;
    if (!progress) continue;
    const previous = existing.find(
      (row) => row.runId === status.runId && row.candidateId === candidate.candidateId,
    );
    const settled = ["accepted", "rejected", "infrastructure_failed"].includes(progress.status);
    const stopped = !settled && interrupted;
    const accepted = item.result?.task && progress.status === "accepted";
    rows.push({
      repoId: repo.id,
      runId: status.runId,
      candidateId: candidate.candidateId,
      taskId: progress.taskId,
      sourcePr: candidate.sourcePr,
      sourceUrl: candidate.sourceUrl,
      difficulty: progress.difficulty,
      stage:
        progress.stage ?? (stopped && status.phase === "cancelled" ? "cancelled" : progress.status),
      ...(progress.round !== undefined ? { round: progress.round } : {}),
      pipelineStatus: stopped ? "infrastructure_failed" : pipelineStatus(progress),
      ...(progress.reason
        ? { reason: progress.reason }
        : stopped
          ? {
              reason:
                status.phase === "cancelled"
                  ? "Generation cancelled."
                  : (status.error ?? `Batch ${status.phase}`),
            }
          : {}),
      ...(accepted && item.result?.task
        ? previous?.bundleKey && previous.definition
          ? { bundleKey: previous.bundleKey, definition: previous.definition }
          : await acceptedTaskFields(artifacts, item.result.task)
        : {}),
    });
  }
  await tasks.upsertMany(rows);
}
