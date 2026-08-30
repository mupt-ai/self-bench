import { setTimeout as delay } from "node:timers/promises";
import { AuthenticationError, InvalidArgumentError } from "e2b";
import type { RollingOutput } from "../../../process.js";
import { SandboxExecutionError, type SandboxRequest, type SandboxResult } from "../../contracts.js";
import { raceWithSignal } from "./lifecycle.js";
import type { E2BSandboxHandle } from "./types.js";

export async function collectPartialOutputs(
  sandbox: E2BSandboxHandle,
  request: SandboxRequest,
  signal: AbortSignal,
  requestTimeoutMs: number,
): Promise<Record<string, Uint8Array>> {
  const outputs: Record<string, Uint8Array> = {};
  await Promise.all(
    (request.outputPaths ?? []).map(async (path) => {
      try {
        signal.throwIfAborted();
        outputs[path] = await raceWithSignal(
          sandbox.files.read(path, { format: "bytes", requestTimeoutMs, signal }),
          signal,
        );
      } catch {
        // Partial outputs are best effort after timeout or infrastructure failure.
      }
    }),
  );
  return outputs;
}

export function sandboxExecutionError(
  failure: unknown,
  sandbox: E2BSandboxHandle,
  stdout: RollingOutput,
  stderr: RollingOutput,
  outputs: Record<string, Uint8Array>,
): SandboxExecutionError {
  const result: SandboxResult = {
    sandboxId: sandbox.sandboxId,
    exitCode: 1,
    stdout: stdout.text(),
    stderr: stderr.text(),
    outputs,
  };
  return new SandboxExecutionError(
    `${errorMessage(failure)}; E2B sandbox ${sandbox.sandboxId}`,
    result,
    { cause: failure },
  );
}

export function createErrorConfirmsNoAllocation(error: unknown): boolean {
  return error instanceof AuthenticationError || error instanceof InvalidArgumentError;
}

export async function waitForCommandKill(
  commandKill: Promise<boolean> | undefined,
  diagnosticSignal: AbortSignal,
  graceMs: number,
): Promise<void> {
  if (!commandKill) return;
  const signal = AbortSignal.any([diagnosticSignal, AbortSignal.timeout(graceMs)]);
  try {
    await raceWithSignal(commandKill, signal);
  } catch {
    // Sandbox cleanup remains the authoritative process/resource stop.
  }
}

export async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await delay(delayMs, undefined, { signal });
}

export function attachCleanupError(primaryError: unknown, cleanupError: unknown): unknown {
  if (primaryError instanceof Error) {
    const message = `${primaryError.message}; E2B sandbox cleanup also failed: ${errorMessage(cleanupError).slice(0, 500)}`;
    try {
      Object.defineProperties(primaryError, {
        cleanupError: { configurable: true, value: cleanupError },
        message: { configurable: true, value: message, writable: true },
      });
      return primaryError;
    } catch {
      const wrapped = new Error(message, { cause: primaryError });
      wrapped.name = primaryError.name;
      Object.defineProperty(wrapped, "cleanupError", { configurable: true, value: cleanupError });
      return wrapped;
    }
  }
  return new AggregateError(
    [primaryError, cleanupError],
    "E2B sandbox execution and cleanup both failed",
  );
}

export function sanitizeCleanupError(error: unknown, redactedValue: string): Error {
  const sanitized = new Error(
    errorMessage(error).replaceAll(redactedValue, "[redacted]").slice(0, 1_000),
  );
  sanitized.name = "E2BSandboxCleanupError";
  return sanitized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
