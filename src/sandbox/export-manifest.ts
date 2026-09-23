import type { RunRequest } from "../contracts/index.js";
export interface DroppedDuplicate {
  readonly taskId: string;
  readonly sourcePr: number;
  readonly keptTaskId: string;
}

export interface ExportManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly candidateCounts: RunRequest["candidateCounts"];
  readonly repository: RunRequest["repository"];
  readonly version: RunRequest["version"];
  readonly acceptedCount: number;
  readonly tasks: readonly { taskId: string; sha256: string }[];
  readonly droppedDuplicates: readonly DroppedDuplicate[];
}

/**
 * Keeps the first accepted task per source pull request, in input order, and records every later
 * task that shares one so the manifest can name both task IDs.
 */
export function dedupeBySourcePr<T extends { readonly taskId: string; readonly sourcePr: number }>(
  tasks: readonly T[],
): { kept: T[]; dropped: DroppedDuplicate[] } {
  const keptBySourcePr = new Map<number, string>();
  const kept: T[] = [];
  const dropped: DroppedDuplicate[] = [];
  for (const task of tasks) {
    const keptTaskId = keptBySourcePr.get(task.sourcePr);
    if (keptTaskId !== undefined) {
      dropped.push({ taskId: task.taskId, sourcePr: task.sourcePr, keptTaskId });
      continue;
    }
    keptBySourcePr.set(task.sourcePr, task.taskId);
    kept.push(task);
  }
  return { kept, dropped };
}

export function exportManifest(
  run: RunRequest,
  tasks: readonly { taskId: string; sha256: string }[],
  droppedDuplicates: readonly DroppedDuplicate[],
): ExportManifest {
  return {
    schemaVersion: 1,
    runId: run.runId,
    candidateCounts: run.candidateCounts,
    repository: run.repository,
    version: run.version,
    acceptedCount: tasks.length,
    tasks,
    droppedDuplicates,
  };
}
