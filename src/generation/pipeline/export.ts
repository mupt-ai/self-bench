import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTask, RunRequest } from "../../contracts/index.js";
import { type ArtifactRef, taskDefinitionSchema } from "../../contracts/index.js";
import type { SandboxFile } from "../../sandbox/contracts.js";
import { dedupeBySourcePr, exportManifest } from "../../sandbox/export-manifest.js";
import { taskOperation } from "../../sandbox/task-operation.js";
import { artifactFile } from "./helpers.js";

export interface ExportInput {
  readonly run: RunRequest;
  readonly tasks: readonly AuthoredTask[];
}

const EXPORT_UPLOAD_TTL_MS = 60 * 60_000;

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
  // The sandbox pulls each bundle itself; buffering them all would hold GBs in the worker.
  for (const [index, entry] of kept.entries())
    files.push(await artifactFile(store, entry.task.bundle, `/work/bundle-${index}.tar.gz`));
  files.push({
    path: "/work/export-input.json",
    contents: JSON.stringify({
      manifest: exportManifest(input.run, [], dropped),
      taskIds: kept.map((entry) => entry.taskId),
    }),
  });
  const archivePath = "/work/export.tar.gz";
  const key = `runs/${input.run.runId}/export/attempt-${attempt}/selfbench-${input.run.runId}.tar.gz`;
  const contentType = "application/gzip";
  // The archive holds every accepted bundle (GBs); read back, it would exceed the API's memory.
  const { outputs, uploaded } = await taskOperation("export", files, [archivePath], {
    uploads: {
      [archivePath]: async ({ sha256 }) =>
        store.signedWriteUrl?.(key, { sha256, contentType }, EXPORT_UPLOAD_TTL_MS),
    },
  });
  const sent = uploaded?.[archivePath];
  if (sent) {
    const stored = await store.stat(key);
    if (stored?.sha256 !== sent.sha256 || stored.sizeBytes !== sent.sizeBytes)
      throw Error("Export sandbox upload does not match its archive");
    return { ...stored, contentType };
  }
  const archive = outputs[archivePath];
  if (!archive) throw Error("Export sandbox returned no archive");
  return store.put(key, archive, contentType);
}
