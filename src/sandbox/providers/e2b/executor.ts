import { type CommandHandle, E2B } from "e2b";
import { RollingOutput } from "../../../process.js";
import type {
  SandboxExecResult,
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "../../contracts.js";
import { LiveSandboxRegistry } from "../../live.js";
import { E2BCleanup } from "./cleanup.js";
import { e2bBacking, executeE2BCommand } from "./command.js";
import type { E2BExecutionConfig, E2BLifecycleTimings, E2BSleep } from "./config.js";
import { abortReason, createTerminationGate, raceWithTermination } from "./lifecycle.js";
import {
  abortableDelay,
  attachCleanupError,
  collectPartialOutputs,
  createErrorConfirmsNoAllocation,
  sandboxExecutionError,
  sanitizeCleanupError,
  waitForCommandKill,
} from "./outcome.js";
import type { E2BSandboxApi, E2BSandboxHandle } from "./types.js";
import {
  validateAllocatedSandbox,
  validateConfig,
  validateLifecycleTimings,
  validateRequest,
} from "./validation.js";

export type { E2BLifecycleTimings } from "./config.js";
export type { E2BSandboxApi, E2BSandboxHandle } from "./types.js";

const CLEANUP_REQUEST_TIMEOUT_MS = 30_000;
const CLEANUP_CALL_TIMEOUT_MS = 10_000;
const CLEANUP_RECOVERY_DELAYS_MS = [0, 250, 750, 1_500, 3_000, 5_000, 7_500, 10_000] as const;
const COMMAND_KILL_GRACE_MS = 500;
const CREATE_REQUEST_TIMEOUT_MS = CLEANUP_REQUEST_TIMEOUT_MS;
const DIAGNOSTIC_TIMEOUT_MS = 5_000;
const HARD_TIMEOUT_EXIT_CODE = 124;
const DEFAULT_LIFECYCLE_TIMINGS: E2BLifecycleTimings = {
  cleanupCallTimeoutMs: CLEANUP_CALL_TIMEOUT_MS,
  cleanupRecoveryDelaysMs: CLEANUP_RECOVERY_DELAYS_MS,
  cleanupTimeoutMs: CLEANUP_REQUEST_TIMEOUT_MS,
  commandKillGraceMs: COMMAND_KILL_GRACE_MS,
  diagnosticTimeoutMs: DIAGNOSTIC_TIMEOUT_MS,
};

type RunOutcome =
  | { readonly ok: true; readonly result: SandboxResult }
  | { readonly ok: false; readonly error: unknown };

class E2BHardTimeoutError extends Error {
  constructor(sandboxId: string, stage: string, timeoutMs: number) {
    super(`E2B sandbox ${sandboxId} stage ${stage} exceeded ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export class E2BSandboxExecutor implements SandboxExecutor {
  readonly #config: E2BExecutionConfig;
  readonly #api: E2BSandboxApi;
  readonly #sleep: E2BSleep;
  readonly #timings: E2BLifecycleTimings;
  readonly #live = new LiveSandboxRegistry();

  constructor(
    config: E2BExecutionConfig,
    api?: E2BSandboxApi,
    sleep: E2BSleep = abortableDelay,
    timings: Partial<E2BLifecycleTimings> = {},
  ) {
    this.#config = validateConfig(config);
    this.#api = api ?? new E2B(this.#config.credentials).Sandbox;
    this.#sleep = sleep;
    this.#timings = validateLifecycleTimings({ ...DEFAULT_LIFECYCLE_TIMINGS, ...timings });
  }

  async run(request: SandboxRequest, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    options.signal?.throwIfAborted();
    const resources = validateRequest(request);
    const allocationId = crypto.randomUUID();
    const expectedSandboxId = `allocation ${allocationId}`;
    const metadata = {
      selfbench_allocation: allocationId,
      selfbench_run: request.runId.slice(0, 256),
      selfbench_stage: request.stage.slice(0, 256),
    };
    const controller = new AbortController();
    const stdout = new RollingOutput();
    const stderr = new RollingOutput();
    let terminationError: unknown;
    let sandbox: E2BSandboxHandle | undefined;
    let command: CommandHandle | undefined;
    let allocationMayExist = false;
    let commandKillPromise: Promise<boolean> | undefined;
    const termination = createTerminationGate();
    const killCommand = (): void => {
      if (!command || commandKillPromise) {
        return;
      }
      try {
        commandKillPromise = command.kill();
      } catch (error) {
        commandKillPromise = Promise.reject(error);
      }
      void commandKillPromise.catch(() => undefined);
    };
    const terminate = (error: unknown): void => {
      if (terminationError !== undefined) {
        return;
      }
      terminationError = error;
      controller.abort(error);
      termination.reject(error);
      killCommand();
    };
    const abort = (): void => terminate(abortReason(options.signal));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    const hardTimeout = setTimeout(() => {
      terminate(
        new E2BHardTimeoutError(
          sandbox?.sandboxId ?? expectedSandboxId,
          request.stage,
          request.timeoutMs,
        ),
      );
    }, request.timeoutMs);
    hardTimeout.unref();

    let outcome: RunOutcome;
    try {
      allocationMayExist = true;
      const create = this.#api
        .create(this.#config.image, {
          lifecycle: { onTimeout: "kill" },
          metadata,
          requestTimeoutMs: Math.min(CREATE_REQUEST_TIMEOUT_MS, request.timeoutMs),
          signal: controller.signal,
          timeoutMs: request.timeoutMs,
        })
        .then(
          (created) => {
            sandbox = created;
            allocationMayExist = false;
            return created;
          },
          (error: unknown) => {
            if (createErrorConfirmsNoAllocation(error)) {
              allocationMayExist = false;
            }
            throw error;
          },
        );
      sandbox = await raceWithTermination(create, termination.promise);
      allocationMayExist = false;
      throwIfTerminated(terminationError);

      const info = await raceWithTermination(
        sandbox.getInfo({ signal: controller.signal }),
        termination.promise,
      );
      validateAllocatedSandbox(sandbox.sandboxId, info, resources, metadata);

      if (request.files && request.files.length > 0) {
        await raceWithTermination(
          sandbox.files.writeFiles(
            request.files.map((file) => ({
              path: file.path,
              data:
                typeof file.contents === "string"
                  ? file.contents
                  : Uint8Array.from(file.contents).buffer,
            })),
            { signal: controller.signal },
          ),
          termination.promise,
        );
      }
      throwIfTerminated(terminationError);

      const execution = await executeE2BCommand({
        sandbox,
        request,
        options,
        signal: controller.signal,
        terminate,
        stdout,
        stderr,
        termination: termination.promise,
        setCommand: (handle) => {
          command = handle;
          if (terminationError !== undefined) {
            killCommand();
          }
        },
        startSupervision: (live) => this.#live.start(live.sandboxId, e2bBacking(live), options),
      });
      throwIfTerminated(terminationError);
      outcome = { ok: true, result: execution };
    } catch (error) {
      killCommand();
      const diagnosticSignal = AbortSignal.timeout(this.#timings.diagnosticTimeoutMs);
      await waitForCommandKill(
        commandKillPromise,
        diagnosticSignal,
        this.#timings.commandKillGraceMs,
      );
      const partialOutputs = sandbox
        ? await collectPartialOutputs(
            sandbox,
            request,
            diagnosticSignal,
            this.#timings.diagnosticTimeoutMs,
          )
        : {};
      const failure = terminationError ?? error;
      if (failure instanceof E2BHardTimeoutError) {
        outcome = {
          ok: true,
          result: {
            sandboxId: sandbox?.sandboxId ?? expectedSandboxId,
            exitCode: HARD_TIMEOUT_EXIT_CODE,
            stdout: stdout.text(),
            stderr: stderr.text(),
            outputs: {},
          },
        };
      } else if (terminationError !== undefined && options.signal?.aborted) {
        outcome = { ok: false, error: failure };
      } else if (sandbox) {
        outcome = {
          ok: false,
          error: sandboxExecutionError(failure, sandbox, stdout, stderr, partialOutputs),
        };
      } else {
        outcome = { ok: false, error: failure };
      }
    }

    clearTimeout(hardTimeout);
    options.signal?.removeEventListener("abort", abort);
    try {
      await new E2BCleanup(this.#api, this.#sleep, this.#timings).cleanup(
        metadata,
        () => sandbox,
        () => allocationMayExist,
      );
    } catch (cleanupError) {
      const publicCleanupError = sanitizeCleanupError(
        cleanupError,
        this.#config.credentials.apiKey,
      );
      outcome = outcome.ok
        ? { ok: false, error: publicCleanupError }
        : { ok: false, error: attachCleanupError(outcome.error, publicCleanupError) };
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
