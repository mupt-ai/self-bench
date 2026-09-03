import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancelledFailure, Context } from "@temporalio/activity";
import { extractRegularArchive } from "../../archive.js";
import type { ArtifactStore } from "../../artifacts.js";
import { type ArtifactRef, type AuthoredTask, taskDefinitionSchema } from "../../contracts.js";
import { refreshHarborTask } from "../../harbor-task.js";
import {
  assertPiSessionFile,
  finalAssistantMessage,
  sessionProviderError,
  toolCallNames,
} from "../../pi-session.js";
import { projectRoot } from "../../project-paths.js";
import { type ProvenanceMessage, provenanceMessageSchema } from "../../provenance.js";
import {
  SandboxExecutionError,
  type SandboxResult,
  type SandboxRunOptions,
} from "../../sandbox/index.js";
import { wrapperStatusFrom } from "./round-outcome.js";

/**
 * Runs a round sandbox. A provider failure after the wrapper already finished (its status file
 * was collected) is downgraded to a result carrying the wrapper's status, with the provider's
 * complaint appended to stderr; any other provider failure stores the partial log and rethrows.
 */
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
    const status = wrapperStatusFrom(error.result.outputs);
    if (status !== undefined) {
      return {
        ...error.result,
        exitCode: status,
        stderr: `${error.result.stderr}\n[selfbench] provider failed after the wrapper finished with status ${status}: ${error.message}\n`,
      };
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
export interface StoredPiSession {
  readonly ref: ArtifactRef;
  readonly finalMessage?: string;
  /** Tool calls the assistant made, in order. */
  readonly toolCalls: readonly string[];
  /** The provider error that ended the session, when the last assistant turn failed. */
  readonly providerError?: string;
}
/**
 * Persists a collected pi session file as a run artifact. An absent or malformed file yields
 * undefined so the caller can report the round rather than fail the activity.
 */
export async function storePiSession(
  store: ArtifactStore,
  key: string,
  bytes: Uint8Array | undefined,
): Promise<StoredPiSession | undefined> {
  if (!bytes || bytes.length === 0) {
    return undefined;
  }
  try {
    assertPiSessionFile(bytes);
  } catch {
    return undefined;
  }
  const ref = await store.put(key, bytes, "application/x-ndjson");
  const finalMessage = finalAssistantMessage(bytes);
  const providerError = sessionProviderError(bytes);
  return {
    ref,
    toolCalls: toolCallNames(bytes),
    ...(finalMessage ? { finalMessage } : {}),
    ...(providerError ? { providerError } : {}),
  };
}
/** Reads the held-out and gold patches from an authored submission or a compiled task root. */
export async function readTaskPatches(
  directory: string,
): Promise<{ readonly testPatch: string; readonly goldPatch: string }> {
  const [testPatch, goldPatch] = await Promise.all([
    readFile(join(directory, "test.patch"), "utf8").catch(() =>
      readFile(join(directory, "tests/test.patch"), "utf8"),
    ),
    readFile(join(directory, "gold.patch"), "utf8").catch(() =>
      readFile(join(directory, "solution/gold.patch"), "utf8"),
    ),
  ]);
  return { testPatch, goldPatch };
}
