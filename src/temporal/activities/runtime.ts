import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancelledFailure, Context } from "@temporalio/activity";
import { extractRegularArchive } from "../../archive.js";
import type { ArtifactStore } from "../../artifacts.js";
import { type AuthoredTask, taskDefinitionSchema } from "../../contracts.js";
import { refreshHarborTask } from "../../harbor-task.js";
import { projectRoot } from "../../project-paths.js";
import { type ProvenanceMessage, provenanceMessageSchema } from "../../provenance.js";
import {
  SandboxExecutionError,
  type SandboxResult,
  type SandboxRunOptions,
} from "../../sandbox/index.js";

export async function runSandboxWithFailureLog(
  store: ArtifactStore,
  logKey: string,
  action: () => Promise<SandboxResult>,
): Promise<SandboxResult> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof SandboxExecutionError)) {
      throw error;
    }
    const log = await store.put(
      logKey,
      Buffer.from(`${error.result.stdout}\n${error.result.stderr}`),
      "text/plain",
    );
    throw new Error(`${error.message}; partial log: ${log.uri}`, { cause: error });
  }
}
export async function withActivityHeartbeats<T>(
  detail: string,
  action: (options: SandboxRunOptions & { readonly signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const context = Context.current();
  let outputBytes = 0;
  let lastOutputAt: string | undefined;
  const heartbeatDetail = (): {
    detail: string;
    outputBytes: number;
    lastOutputAt?: string;
  } => ({
    detail,
    outputBytes,
    ...(lastOutputAt ? { lastOutputAt } : {}),
  });
  context.heartbeat(heartbeatDetail());
  const heartbeat = setInterval(() => context.heartbeat(heartbeatDetail()), 60_000);
  heartbeat.unref();
  try {
    try {
      const result = await action({
        signal: context.cancellationSignal,
        onProgress: (progress) => {
          outputBytes += progress.bytes;
          lastOutputAt = new Date().toISOString();
        },
      });
      if (context.cancellationSignal.aborted) {
        throw new CancelledFailure("activity cancellation requested");
      }
      return result;
    } catch (error) {
      if (context.cancellationSignal.aborted && !(error instanceof CancelledFailure)) {
        throw new CancelledFailure("activity cancellation requested");
      }
      throw error;
    }
  } finally {
    clearInterval(heartbeat);
  }
}
export async function withTaskBundle<T>(
  store: ArtifactStore,
  task: AuthoredTask,
  action: (taskDirectory: string, root: string) => Promise<T>,
): Promise<T> {
  return await withTemporaryDirectory(`selfbench-${task.taskId}-`, async (root) => {
    const archive = join(root, "task.tar.gz");
    await writeFile(archive, await store.get(task.bundle));
    await extractRegularArchive(archive, root);
    const taskDirectory = join(root, "harbor-task");
    const definition = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(await store.get(task.definition)).toString("utf8")),
    );
    await refreshHarborTask(taskDirectory, definition);
    return await action(taskDirectory, root);
  });
}
export async function withTemporaryDirectory<T>(
  prefix: string,
  action: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export function parseProvenance(value: Uint8Array): ProvenanceMessage[] {
  return Buffer.from(value)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => provenanceMessageSchema.parse(JSON.parse(line)));
}
export function readAsset(relativePath: string): Promise<Buffer> {
  return readFile(join(projectRoot(import.meta.url), relativePath));
}
