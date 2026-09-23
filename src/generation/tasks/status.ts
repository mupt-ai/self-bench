import type { ArtifactStore } from "../../artifacts/index.js";
import type { CandidateWorkflowResult, TaskProgress } from "../../contracts/index.js";
import type { TaskRecord, TaskStore } from "../../db/tasks.js";
import type { SandboxCostSnapshot } from "../../sandbox/contracts.js";
import { syncRun } from "./sync.js";

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

/** What the site can learn about a task's workflow without owning it. */
export type WorkflowSnapshot =
  | {
      readonly kind: "running";
      readonly progress?: TaskProgress;
      readonly cost?: SandboxCostSnapshot;
    }
  | { readonly kind: "completed"; readonly result: CandidateWorkflowResult }
  | { readonly kind: "failed"; readonly status: string; readonly detail?: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unknown" };

export interface TaskStatusSource {
  snapshot(workflowId: string): Promise<WorkflowSnapshot>;
  cancel?(workflowId: string): Promise<void>;
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
  const running = (await options.tasks.listForRepo(options.repo.id)).filter(
    (task) =>
      task.pipelineStatus === "in_progress" ||
      (task.pipelineStatus === "accepted" && !task.bundleKey),
  );
  let changed = 0;
  for (const task of running) {
    if ((await refreshTask(options, task)).changed) changed += 1;
  }
  return changed;
}

/** Refreshes one task without polling every active workflow in its repository. */
export async function refreshTask(
  options: RefreshOptions,
  task: TaskRecord,
): Promise<{ task: TaskRecord; snapshot?: WorkflowSnapshot; changed: boolean }> {
  const { tasks, artifacts, status, repo } = options;
  if (task.pipelineStatus === "accepted" && !task.bundleKey) {
    const result = await syncRun({
      tasks,
      artifacts,
      repo,
      runId: task.runId,
      repairAcceptedTask: task,
    }).catch(() => undefined);
    return {
      task: (await tasks.find(repo.id, task.runId, task.candidateId)) ?? task,
      changed: Boolean(result?.synced),
    };
  }
  if (task.pipelineStatus !== "in_progress" || !task.workflowId) return { task, changed: false };
  const snapshot = await status
    .snapshot(task.workflowId)
    .catch((): WorkflowSnapshot => ({ kind: "unknown" }));
  if (
    snapshot.kind === "completed" &&
    snapshot.result.progress.status !== "infrastructure_failed"
  ) {
    await syncRun({
      tasks,
      artifacts,
      repo,
      runId: task.runId,
      completedWorkflowId: task.workflowId,
    }).catch(() => undefined);
  }
  const updated = await applySnapshot(task, snapshot, tasks);
  return {
    task: updated ?? task,
    snapshot,
    changed: updated !== undefined,
  };
}

async function applySnapshot(
  task: TaskRecord,
  snapshot: WorkflowSnapshot,
  tasks: TaskStore,
): Promise<TaskRecord | undefined> {
  switch (snapshot.kind) {
    case "running": {
      const progress = snapshot.progress;
      if (!progress) return undefined;
      if (progress.stage === task.stage && progress.round === task.round) return undefined;
      return tasks.progress(task.id, {
        stage: progress.stage ?? task.stage,
        ...(progress.round !== undefined ? { round: progress.round } : {}),
        pipelineStatus: "in_progress",
        ...(progress.taskId && progress.taskId !== task.candidateId
          ? { taskId: progress.taskId }
          : {}),
      });
    }
    case "completed": {
      const progress = snapshot.result.progress;
      return tasks.progress(task.id, {
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
    }
    case "cancelled": {
      return tasks.progress(task.id, {
        stage: "cancelled",
        ...(task.round !== undefined ? { round: task.round } : {}),
        pipelineStatus: "infrastructure_failed",
        reason: "Generation cancelled.",
      });
    }
    case "failed": {
      const detail = `workflow ${snapshot.status.toLowerCase()}${snapshot.detail ? `: ${snapshot.detail}` : ""}`;
      return tasks.progress(task.id, {
        stage: task.stage,
        ...(task.round !== undefined ? { round: task.round } : {}),
        pipelineStatus: "infrastructure_failed",
        reason: `${infrastructureFailureSummary(detail)}\n\nTechnical details: ${detail}`,
      });
    }
    default:
      return undefined;
  }
}
