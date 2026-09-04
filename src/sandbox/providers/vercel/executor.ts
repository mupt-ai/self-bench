import type { Sandbox } from "@vercel/sandbox";
import { RollingOutput } from "../../../process.js";
import type {
  SandboxExecResult,
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "../../contracts.js";
import { LiveSandboxRegistry } from "../../live.js";
import { materializeRemoteFiles } from "../../remote-files.js";
import { executeVercelCommand, VERCEL_WORK_DIRECTORY, vercelBacking } from "./command.js";
import { preventAmbiguousVercelCommandStartRetries } from "./fetch.js";
import {
  abortableDelay,
  type Sleep,
  sandboxName,
  VERCEL_CLEANUP_TIMEOUT_MS,
  VercelSandboxLifecycle,
} from "./lifecycle.js";
import { type VercelExecutionConfig, validateConfig, validateRequest } from "./validation.js";

const HARD_TIMEOUT_EXIT_CODE = 124;

type RunOutcome =
  | { readonly ok: true; readonly result: SandboxResult }
  | { readonly ok: false; readonly error: unknown };

class VercelHardTimeoutError extends Error {
  constructor(name: string, stage: string, timeoutMs: number) {
    super(`Vercel sandbox ${name} stage ${stage} exceeded ${timeoutMs}ms`);
    // Passed as the abort reason to in-flight SDK calls, so it carries the
    // standard DOMException timeout name. run() converts it into an exit-124
    // result rather than throwing.
    this.name = "TimeoutError";
  }
}

export class VercelSandboxExecutor implements SandboxExecutor {
  readonly #config: VercelExecutionConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: Sleep;
  readonly #live = new LiveSandboxRegistry();

  constructor(
    config: VercelExecutionConfig,
    fetch = globalThis.fetch,
    sleep: Sleep = abortableDelay,
  ) {
    this.#config = validateConfig(config);
    this.#fetch = preventAmbiguousVercelCommandStartRetries(fetch);
    this.#sleep = sleep;
  }

  async run(request: SandboxRequest, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    options.signal?.throwIfAborted();
    const resources = validateRequest(request);

    const name = sandboxName(request.runId, request.stage);
    const tags = {
      selfbench_run: request.runId.slice(0, 256),
      selfbench_stage: request.stage.slice(0, 256),
    };
    const controller = new AbortController();
    const stdout = new RollingOutput();
    const stderr = new RollingOutput();
    let terminationError: unknown;
    let sandbox: Sandbox | undefined;
    let deletePromise: Promise<void> | undefined;
    let allocationMayExist = false;

    const deleteHandle = (): Promise<void> => {
      if (!sandbox) {
        return Promise.resolve();
      }
      deletePromise ??= sandbox.delete({ signal: AbortSignal.timeout(VERCEL_CLEANUP_TIMEOUT_MS) });
      return deletePromise;
    };
    const terminate = (error: unknown): void => {
      if (terminationError !== undefined) {
        return;
      }
      terminationError = error;
      controller.abort(error);
      if (sandbox) {
        void deleteHandle().catch(() => undefined);
      }
    };
    const abort = (): void => terminate(abortReason(options.signal));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    const hardTimeout = setTimeout(() => {
      terminate(new VercelHardTimeoutError(name, request.stage, request.timeoutMs));
    }, request.timeoutMs);
    hardTimeout.unref();

    let outcome: RunOutcome;
    try {
      sandbox = await new VercelSandboxLifecycle(
        this.#config,
        this.#fetch,
        this.#sleep,
      ).createSandbox(
        name,
        tags,
        resources.vcpus,
        request.timeoutMs,
        controller.signal,
        (value) => {
          allocationMayExist = value;
        },
      );
      allocationMayExist = false;
      throwIfTerminated(terminationError);

      const session = sandbox.currentSession();
      if (session.status !== "running") {
        throw new Error(`Vercel sandbox ${name} was created in unexpected state ${session.status}`);
      }
      if (session.cwd !== VERCEL_WORK_DIRECTORY) {
        throw new Error(
          `Vercel image ${this.#config.image} has workdir ${session.cwd}; expected ${VERCEL_WORK_DIRECTORY}`,
        );
      }
      if (session.vcpus !== resources.vcpus || session.memory !== resources.memoryMiB) {
        throw new Error(
          `Vercel sandbox ${name} returned ${session.vcpus} vCPU/${session.memory} MiB; expected ${resources.vcpus} vCPU/${resources.memoryMiB} MiB`,
        );
      }

      const files = await materializeRemoteFiles(request.files ?? [], controller.signal);
      if (files.length > 0) {
        await session.writeFiles(
          files.map((file) => ({ path: file.path, content: file.contents })),
          { signal: controller.signal },
        );
      }
      throwIfTerminated(terminationError);

      const outputs = await executeVercelCommand({
        session,
        request,
        options,
        signal: controller.signal,
        terminate,
        stdout,
        stderr,
        startSupervision: () => this.#live.start(name, vercelBacking(session), options),
        sleep: this.#sleep,
      });
      throwIfTerminated(terminationError);
      outcome = { ok: true, result: { sandboxId: sandbox.name, ...outputs } };
    } catch (error) {
      const failure = terminationError ?? error;
      outcome =
        failure instanceof VercelHardTimeoutError
          ? {
              ok: true,
              result: {
                sandboxId: sandbox?.name ?? name,
                exitCode: HARD_TIMEOUT_EXIT_CODE,
                stdout: stdout.text(),
                stderr: stderr.text(),
                outputs: {},
              },
            }
          : { ok: false, error: failure };
    }

    clearTimeout(hardTimeout);
    options.signal?.removeEventListener("abort", abort);
    try {
      await new VercelSandboxLifecycle(this.#config, this.#fetch, this.#sleep).cleanup(
        name,
        sandbox,
        deleteHandle,
        allocationMayExist,
      );
    } catch (cleanupError) {
      const publicCleanupError = sanitizeCleanupError(cleanupError, this.#config.credentials.token);
      outcome = outcome.ok
        ? { ok: false, error: publicCleanupError }
        : {
            ok: false,
            error: attachCleanupError(outcome.error, publicCleanupError),
          };
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.result;
  }

  execute(sandboxId: string, command: readonly string[]): Promise<SandboxExecResult> {
    return this.#live.execute(sandboxId, command);
  }

  readFile(sandboxId: string, path: string): Promise<Uint8Array | undefined> {
    return this.#live.readFile(sandboxId, path);
  }

  writeFile(sandboxId: string, path: string, contents: Uint8Array | string): Promise<void> {
    return this.#live.writeFile(sandboxId, path, contents);
  }

  close(): void {}
}

function throwIfTerminated(error: unknown): void {
  if (error !== undefined) {
    throw error;
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function attachCleanupError(primaryError: unknown, cleanupError: unknown): unknown {
  if (primaryError instanceof Error) {
    const cleanupMessage = errorMessage(cleanupError).slice(0, 500);
    const message = `${primaryError.message}; Vercel sandbox cleanup also failed: ${cleanupMessage}`;
    try {
      Object.defineProperties(primaryError, {
        cleanupError: { configurable: true, value: cleanupError },
        message: { configurable: true, value: message, writable: true },
      });
      return primaryError;
    } catch {
      const wrapped = new Error(message, { cause: primaryError });
      wrapped.name = primaryError.name;
      Object.defineProperty(wrapped, "cleanupError", {
        configurable: true,
        value: cleanupError,
      });
      return wrapped;
    }
  }
  return new AggregateError(
    [primaryError, cleanupError],
    "Vercel sandbox execution and cleanup both failed",
  );
}

function sanitizeCleanupError(error: unknown, redactedValue: string): Error {
  const sanitized = new Error(
    errorMessage(error).replaceAll(redactedValue, "[redacted]").slice(0, 1_000),
  );
  sanitized.name = "VercelSandboxCleanupError";
  return sanitized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
