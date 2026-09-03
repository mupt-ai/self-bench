import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import { extractRegularArchive } from "../../archive.js";
import type { ArtifactStore } from "../../artifacts.js";
import {
  type ArtifactRef,
  type AuthoredTask,
  type RunRequest,
  type TaskDefinition,
  taskDefinitionSchema,
} from "../../contracts.js";
import { refreshHarborTask } from "../../harbor-task.js";
import { sha256 } from "../../hash.js";
import { runCommand } from "../../process.js";
import { withTemporaryDirectory } from "./runtime.js";
import type { ExportInput } from "./types.js";

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

export async function buildExport(store: ArtifactStore, input: ExportInput): Promise<ArtifactRef> {
  return await withTemporaryDirectory("selfbench-export-", async (root) => {
    const tasksRoot = join(root, "tasks");
    await mkdir(tasksRoot, { recursive: true });
    const accepted: { task: AuthoredTask; definition: TaskDefinition }[] = [];
    for (const task of input.tasks) {
      accepted.push({ task, definition: await readDefinition(store, task) });
    }
    const { kept, dropped } = dedupeBySourcePr(
      accepted.map(({ task, definition }) => ({
        taskId: task.taskId,
        sourcePr: definition.sourcePr,
        task,
        definition,
      })),
    );
    const manifestTasks: { taskId: string; sha256: string }[] = [];
    for (const { task, definition } of kept) {
      const path = join(tasksRoot, `${task.taskId}.tar.gz`);
      await packageTask(store, root, task, definition, path);
      manifestTasks.push({ taskId: task.taskId, sha256: sha256(await readFile(path)) });
    }
    await writeFile(
      join(root, "manifest.json"),
      `${JSON.stringify(exportManifest(input.run, manifestTasks, dropped), null, 2)}\n`,
    );
    const archive = join(root, "export.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", root, "manifest.json", "tasks"]);
    return await store.putFile(
      `runs/${input.run.runId}/export/attempt-${Context.current().info.attempt}/selfbench-${input.run.runId}.tar.gz`,
      archive,
      "application/gzip",
    );
  });
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

async function readDefinition(store: ArtifactStore, task: AuthoredTask): Promise<TaskDefinition> {
  return taskDefinitionSchema.parse(
    JSON.parse(Buffer.from(await store.get(task.definition)).toString("utf8")),
  );
}

async function packageTask(
  store: ArtifactStore,
  root: string,
  task: AuthoredTask,
  definition: TaskDefinition,
  path: string,
): Promise<void> {
  const expanded = join(root, `expanded-${task.taskId}`);
  const sourceArchive = join(expanded, "source.tar.gz");
  await mkdir(expanded, { recursive: true });
  await writeFile(sourceArchive, await store.get(task.bundle));
  await extractRegularArchive(sourceArchive, expanded);
  await refreshHarborTask(join(expanded, "harbor-task"), definition);
  await runCommand("tar", ["-czf", path, "-C", expanded, "harbor-task"]);
}
