import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTask, RunRequest } from "../../contracts/index.js";
import { type ArtifactRef, taskDefinitionSchema } from "../../contracts/index.js";
import type { SandboxFile } from "../../sandbox/contracts.js";
import { dedupeBySourcePr, exportManifest } from "../../sandbox/export-manifest.js";
import { taskOperation } from "../../sandbox/task-operation.js";

export interface ExportInput {
  readonly run: RunRequest;
  readonly tasks: readonly AuthoredTask[];
}

export { dedupeBySourcePr, exportManifest } from "../../sandbox/export-manifest.js";

/** Only metadata and opaque artifacts cross the worker. Archive creation is sandbox-owned. */
export async function buildExport(
  store: ArtifactStore,
  input: ExportInput,
  attempt: string | number = Context.current().info.attempt,
): Promise<ArtifactRef> {
  const entries = [];
  for (const task of input.tasks) {
    const definition = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(await store.get(task.definition)).toString()),
    );
    entries.push({ task, taskId: task.taskId, sourcePr: definition.sourcePr });
  }
  const { kept, dropped } = dedupeBySourcePr(entries);
  const files: SandboxFile[] = [];
  for (const [index, entry] of kept.entries())
    files.push({
      path: `/work/bundle-${index}.tar.gz`,
      contents: await store.get(entry.task.bundle),
    });
  files.push({
    path: "/work/export-input.json",
    contents: JSON.stringify({
      manifest: exportManifest(input.run, [], dropped),
      taskIds: kept.map((entry) => entry.taskId),
    }),
  });
  const outputs = await taskOperation("export", files, ["/work/export.tar.gz"]);
  const archive = outputs["/work/export.tar.gz"];
  if (!archive) throw Error("Export sandbox returned no archive");
  return store.put(
    `runs/${input.run.runId}/export/attempt-${attempt}/selfbench-${input.run.runId}.tar.gz`,
    archive,
    "application/gzip",
  );
}
