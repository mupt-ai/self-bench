import type { ArtifactStore } from "../artifacts.js";
import type { CandidateWorkflowResult, TaskProgress } from "../contracts.js";
import type { TaskRecord, TaskStore } from "./task-store.js";
import { syncRun } from "./task-sync.js";

export function infrastructureFailureSummary(reason: string): string {
  if (/client_email|GoogleAuth|sign data/i.test(reason)) {
    return "Run Failed: artifact storage credentials are incomplete. Ask an administrator to configure the worker's Google Cloud service account.";
  }
  if (/package.json above|worktree|ENOENT/i.test(reason)) {
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

/** What the site can learn about a task's workflow without owning it. */
export type WorkflowSnapshot =
  | { readonly kind: "running"; readonly progress?: TaskProgress }
  | { readonly kind: "completed"; readonly result: CandidateWorkflowResult }
  | { readonly kind: "failed"; readonly status: string; readonly detail?: string }
  | { readonly kind: "unknown" };

export interface TaskStatusSource {
  snapshot(workflowId: string): Promise<WorkflowSnapshot>;
}

export interface RefreshOptions {
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
  readonly status: TaskStatusSource;
  readonly repo: { readonly id: number; readonly fullName: string };
}

/**
 * Brings every in-progress row for a repo up to date with its workflow: stage and round while
 * it runs, the verdict when it ends, and the artifact-backed fields (definition, bundle) after.
 */
export async function refreshInProgress(options: RefreshOptions): Promise<number> {
  const { tasks, artifacts, status, repo } = options;
  const running = await tasks.inProgress(repo.id);
  let changed = 0;
  for (const task of running) {
    if (!task.workflowId) continue;
    const snapshot = await status
      .snapshot(task.workflowId)
      .catch((): WorkflowSnapshot => ({ kind: "unknown" }));
    if (await applySnapshot(task, snapshot, tasks)) changed += 1;
    if (
      snapshot.kind === "completed" &&
      snapshot.result.progress.status !== "infrastructure_failed"
    ) {
      await syncRun({ tasks, artifacts, repo, runId: task.runId }).catch(() => undefined);
    }
  }
  return changed;
}

async function applySnapshot(
  task: TaskRecord,
  snapshot: WorkflowSnapshot,
  tasks: TaskStore,
): Promise<boolean> {
  switch (snapshot.kind) {
    case "running": {
      const progress = snapshot.progress;
      if (!progress) return false;
      if (progress.stage === task.stage && progress.round === task.round) return false;
      await tasks.progress(task.id, {
        stage: progress.stage ?? task.stage,
        ...(progress.round !== undefined ? { round: progress.round } : {}),
        pipelineStatus: "in_progress",
        ...(progress.taskId && progress.taskId !== task.candidateId
          ? { taskId: progress.taskId }
          : {}),
      });
      return true;
    }
    case "completed": {
      const progress = snapshot.result.progress;
      await tasks.progress(task.id, {
        stage: progress.status === "accepted" ? "accepted" : (progress.stage ?? task.stage),
        ...(progress.round !== undefined ? { round: progress.round } : {}),
        pipelineStatus:
          progress.status === "accepted"
            ? "accepted"
            : progress.status === "infrastructure_failed"
              ? "infrastructure_failed"
              : "rejected",
        ...(progress.reason
          ? {
              reason:
                progress.status === "infrastructure_failed"
                  ? `${infrastructureFailureSummary(progress.reason)}\n\nTechnical details: ${progress.reason}`
                  : progress.reason,
            }
          : {}),
        ...(snapshot.result.task?.taskId ? { taskId: snapshot.result.task.taskId } : {}),
      });
      return true;
    }
    case "failed":
      await tasks.progress(task.id, {
        stage: task.stage,
        ...(task.round !== undefined ? { round: task.round } : {}),
        pipelineStatus: "infrastructure_failed",
        reason: infrastructureFailureSummary(
          `workflow ${snapshot.status.toLowerCase()}${snapshot.detail ? `: ${snapshot.detail}` : ""}`,
        ),
      });
      return true;
    default:
      return false;
  }
}
