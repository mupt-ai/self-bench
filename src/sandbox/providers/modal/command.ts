import { setTimeout as delay } from "node:timers/promises";
import type { Sandbox, Secret } from "modal";
import { InactivityTimeoutError, RollingOutput } from "../../../lib/process.js";
import { errorMessage } from "../../../lib/util.js";
import {
  SandboxExecutionError,
  type SandboxRequest,
  type SandboxResult,
  type SandboxRunOptions,
} from "../../contracts.js";
import type { LiveSandboxRegistry, Supervision } from "../../live.js";
import { readOutputWithRetry } from "../../output-retry.js";
import { markOwnershipFailure } from "../../ownership.js";
import type { ModalDeadline } from "./lifecycle.js";
import { modalBacking } from "./live.js";

const FAILURE_DRAIN_TIMEOUT_MS = 1_000;

export async function runModalCommand(
  sandbox: Sandbox,
  secrets: Secret[],
  request: SandboxRequest,
  options: SandboxRunOptions,
  deadline: ModalDeadline,
  live: LiveSandboxRegistry,
): Promise<SandboxResult> {
  const stdoutOutput = new RollingOutput();
  const stderrOutput = new RollingOutput();
  const outputs: Record<string, Uint8Array> = {};
  const readers = new Set<ReadableStreamDefaultReader<string | Uint8Array>>();
  let supervision: Supervision | undefined;
  let stopped = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let notifyFailure = (): void => {};
  let exitCode: number | undefined;
  let processError: unknown;
  let executionError: unknown;
  const result = (): SandboxResult => ({
    sandboxId: sandbox.sandboxId,
    exitCode: exitCode ?? 1,
    stdout: stdoutOutput.text(),
    stderr: stderrOutput.text(),
    outputs,
  });
  try {
    const process = await deadline.run(() =>
      sandbox.exec([...request.command], {
        env: { ...request.environment },
        ...(secrets.length > 0 ? { secrets } : {}),
      }),
    );
    await deadline.run(() => process.closeStdin());
    supervision = live.start(sandbox.sandboxId, modalBacking(sandbox), options);
    let inactivityError: InactivityTimeoutError | undefined;
    const failure = new Promise<void>((resolve) => {
      notifyFailure = resolve;
    });
    const clearInactivityTimer = (): void => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = undefined;
      }
    };
    const armInactivityTimer = (): void => {
      clearInactivityTimer();
      if (stopped || !request.inactivityTimeoutMs) {
        return;
      }
      inactivityTimer = setTimeout(() => {
        inactivityError = new InactivityTimeoutError(
          `Modal sandbox ${sandbox.sandboxId} stage ${request.stage}`,
          request.inactivityTimeoutMs ?? 0,
        );
        executionError ??= inactivityError;
        notifyFailure();
      }, request.inactivityTimeoutMs);
      inactivityTimer.unref();
    };
    const consume = async (
      streamName: "stdout" | "stderr",
      stream: ReadableStream<string | Uint8Array>,
      output: RollingOutput,
    ): Promise<void> => {
      const reader = stream.getReader();
      readers.add(reader);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done || stopped) {
            return;
          }
          if (value !== undefined) {
            const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
            output.push(chunk);
            options.onProgress?.({ stream: streamName, bytes: chunk.byteLength });
            options.onOutput?.(streamName, chunk);
            armInactivityTimer();
          }
        }
      } finally {
        readers.delete(reader);
        reader.releaseLock();
      }
    };
    let streamError: unknown;
    const captureFailure = (error: unknown): void => {
      streamError ??= error;
      executionError ??= error;
      notifyFailure();
    };
    armInactivityTimer();
    const completion = Promise.all([
      process.wait().then(
        (value) => {
          exitCode = value;
        },
        (error: unknown) => {
          processError = error;
          executionError ??= error;
          notifyFailure();
        },
      ),
      consume("stdout", process.stdout, stdoutOutput).catch(captureFailure),
      consume("stderr", process.stderr, stderrOutput).catch(captureFailure),
    ]);
    await deadline
      .run(() => Promise.race([completion, failure.then(() => delay(FAILURE_DRAIN_TIMEOUT_MS))]))
      .finally(clearInactivityTimer);
    if (readers.size > 0) {
      void Promise.allSettled([...readers].map((reader) => reader.cancel()));
    }
    const currentSupervision = supervision;
    await deadline
      .run(() => currentSupervision.finish())
      .catch((error: unknown) => {
        executionError ??= error;
      });
    executionError ??= deadline.signal.reason ?? inactivityError ?? processError ?? streamError;
    for (const path of request.outputPaths ?? []) {
      const { value, lastError } = await deadline.run(() =>
        readOutputWithRetry(() => deadline.run(() => sandbox.filesystem.readBytes(path)), {
          signal: deadline.signal,
        }),
      );
      if (value !== undefined) outputs[path] = value;
      else if (!executionError && exitCode === 0) {
        executionError = new Error(`Missing requested Modal output: ${path}`, { cause: lastError });
      }
    }
    if (executionError) throw executionError;
    const settlement = currentSupervision.settlement();
    if (settlement.status === "failed") throw settlement.error;
    return result();
  } catch (error) {
    const primary = executionError ?? processError ?? error;
    const failure = new SandboxExecutionError(
      `${errorMessage(primary)}; sandbox ${sandbox.sandboxId}`,
      result(),
      { cause: primary },
    );
    if (supervision) {
      void supervision.finish().catch(() => undefined);
      if (supervision.settlement().status !== "succeeded") {
        // Keep the primary cause, but never recover wrapper success while owned
        // work failed or remains unsettled. The getter retains late hook failure.
        const currentSupervision = supervision;
        throw markOwnershipFailure(failure, () => {
          const settlement = currentSupervision.settlement();
          if (settlement.status !== "failed") return undefined;
          return "lateError" in settlement ? settlement.lateError : settlement.error;
        });
      }
    }
    throw failure;
  } finally {
    stopped = true;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    void Promise.allSettled([...readers].map((reader) => reader.cancel()));
    if (supervision) void supervision.finish().catch(() => undefined);
  }
}
