import type { ArtifactStore } from "../artifacts.js";
import type { RunPhase, RunStatus } from "../contracts.js";
import type { ConnectedRepo } from "./repo-store.js";
import type { TaskStore } from "./task-store.js";
import { syncRun } from "./task-sync.js";

export type BatchStatus = Pick<RunStatus, "runId" | "phase"> &
  Partial<Omit<RunStatus, "runId" | "phase">> & {
    activity?: Record<string, "running" | "queued" | "unknown">;
  };
export const terminalBatch = (phase: RunPhase): boolean =>
  ["complete", "failed", "blocked", "cancelled"].includes(phase);

/** Import artifacts first, then overlay live stages without ever writing human review fields. */
export async function syncBatchProgress(options: {
  repo: ConnectedRepo;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  status: BatchStatus;
}): Promise<void> {
  const { repo, tasks, artifacts, status } = options;
  await syncRun({ repo, tasks, artifacts, runId: status.runId, preserveUnfinished: true });
  const existing = await tasks.listForRepo(repo.id);
  for (const progress of status.tasks ?? []) {
    const previous = existing.find(
      (row) => row.runId === status.runId && row.candidateId === progress.candidateId,
    );
    const { reason: _previousReason, ...metadata } = previous ?? {};
    const settled = ["accepted", "rejected", "infrastructure_failed"].includes(progress.status);
    const interrupted = !settled && terminalBatch(status.phase);
    await tasks.upsertMany([
      {
        ...metadata,
        repoId: repo.id,
        runId: status.runId,
        candidateId: progress.candidateId,
        taskId: progress.taskId,
        difficulty: progress.difficulty,
        stage: progress.stage ?? progress.status,
        ...(progress.round !== undefined ? { round: progress.round } : {}),
        pipelineStatus:
          progress.status === "accepted"
            ? "accepted"
            : progress.status === "rejected"
              ? "rejected"
              : progress.status === "infrastructure_failed" || interrupted
                ? "infrastructure_failed"
                : "in_progress",
        ...(progress.reason
          ? { reason: progress.reason }
          : interrupted
            ? { reason: `Batch ${status.phase}` }
            : {}),
      },
    ]);
  }
  // Query handlers may be unavailable after failure/cancellation; settle previously observed rows.
  if (terminalBatch(status.phase)) {
    for (const task of await tasks.listForRepo(repo.id)) {
      if (task.runId !== status.runId || task.pipelineStatus !== "in_progress") continue;
      await tasks.progress(task.id, {
        stage: task.stage,
        ...(task.round !== undefined ? { round: task.round } : {}),
        pipelineStatus: "infrastructure_failed",
        reason: status.error ?? `Batch ${status.phase} without a task verdict`,
      });
    }
  }
}
