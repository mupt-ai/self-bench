import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AuthenticationError,
  type CommandHandle,
  E2B,
  InvalidArgumentError,
  type Sandbox,
  type SandboxInfo,
  SandboxNotFoundError,
} from "e2b";
import type { SelfBenchWorkerConfig } from "../../../config.js";
import { RollingOutput } from "../../../process.js";
import { normalizeE2BDomain, normalizeE2BTemplateReference } from "../../../setup/e2b/template.js";
import {
  SandboxExecutionError,
  type SandboxExecutor,
  type SandboxRequest,
  type SandboxResult,
  type SandboxRunOptions,
} from "../../contracts.js";
import { E2B_WORK_DIRECTORY, executeE2BCommand } from "./command.js";
import {
  abortReason,
  createTerminationGate,
  raceWithSignal,
  raceWithTermination,
} from "./lifecycle.js";
import type { E2BSandboxApi, E2BSandboxHandle } from "./types.js";

export type { E2BSandboxApi, E2BSandboxHandle } from "./types.js";

const CLEANUP_REQUEST_TIMEOUT_MS = 30_000;
const CLEANUP_CALL_TIMEOUT_MS = 10_000;
const CLEANUP_RECOVERY_DELAYS_MS = [0, 250, 750, 1_500, 3_000, 5_000, 7_500, 10_000] as const;
const COMMAND_KILL_GRACE_MS = 500;
const CREATE_REQUEST_TIMEOUT_MS = CLEANUP_REQUEST_TIMEOUT_MS;
const DIAGNOSTIC_TIMEOUT_MS = 5_000;
const HARD_TIMEOUT_EXIT_CODE = 124;
const MAX_E2B_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

type E2BExecutionConfig = Extract<SelfBenchWorkerConfig["execution"], { readonly kind: "e2b" }>;

export interface E2BLifecycleTimings {
  readonly cleanupCallTimeoutMs: number;
  readonly cleanupRecoveryDelaysMs: readonly number[];
  readonly cleanupTimeoutMs: number;
  readonly commandKillGraceMs: number;
  readonly diagnosticTimeoutMs: number;
}

const DEFAULT_LIFECYCLE_TIMINGS: E2BLifecycleTimings = {
  cleanupCallTimeoutMs: CLEANUP_CALL_TIMEOUT_MS,
  cleanupRecoveryDelaysMs: CLEANUP_RECOVERY_DELAYS_MS,
  cleanupTimeoutMs: CLEANUP_REQUEST_TIMEOUT_MS,
  commandKillGraceMs: COMMAND_KILL_GRACE_MS,
  diagnosticTimeoutMs: DIAGNOSTIC_TIMEOUT_MS,
};

type Sleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

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
  readonly #sleep: Sleep;
  readonly #timings: E2BLifecycleTimings;

  constructor(
    config: E2BExecutionConfig,
    api?: E2BSandboxApi,
    sleep: Sleep = abortableDelay,
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
        const result = collectFailureResult(sandbox, stdout, stderr, partialOutputs);
        outcome = {
          ok: false,
          error: new SandboxExecutionError(
            `${errorMessage(failure)}; E2B sandbox ${sandbox.sandboxId}`,
            result,
            { cause: failure },
          ),
        };
      } else {
        outcome = { ok: false, error: failure };
      }
    }

    clearTimeout(hardTimeout);
    options.signal?.removeEventListener("abort", abort);
    try {
      await this.#cleanup(
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

  close(): void {}

  async #cleanup(
    metadata: Readonly<Record<string, string>>,
    getSandbox: () => E2BSandboxHandle | undefined,
    allocationMayExist: () => boolean,
  ): Promise<void> {
    const signal = AbortSignal.timeout(this.#timings.cleanupTimeoutMs);
    const sandbox = getSandbox();
    if (sandbox) {
      await this.#cleanupKnownSandbox(sandbox, signal);
      return;
    }
    if (!allocationMayExist()) {
      return;
    }

    let recoveryError: unknown;
    for (const delayMs of this.#timings.cleanupRecoveryDelaysMs) {
      try {
        if (delayMs > 0) {
          signal.throwIfAborted();
          await raceWithSignal(this.#sleep(delayMs, signal), signal);
        }
        const lateSandbox = getSandbox();
        if (lateSandbox) {
          await this.#cleanupKnownSandbox(lateSandbox, signal);
          return;
        }
        if (!allocationMayExist()) {
          return;
        }
        const matches = await this.#findSandboxes(metadata, signal);
        if (matches.length === 0) {
          continue;
        }
        for (const match of matches) {
          await this.#killAndConfirmAbsent(match.sandboxId, signal);
        }
        return;
      } catch (error) {
        recoveryError = error;
      }
    }
    const detail = recoveryError
      ? errorMessage(recoveryError)
      : "sandbox absence remained unconfirmed after an ambiguous create failure";
    throw new Error(`failed to recover an E2B sandbox after ambiguous creation: ${detail}`, {
      cause: recoveryError,
    });
  }

  async #cleanupKnownSandbox(sandbox: E2BSandboxHandle, signal: AbortSignal): Promise<void> {
    let directKillError: unknown;
    try {
      await this.#cleanupCall(
        (callSignal) =>
          sandbox.kill(cleanupOptions(callSignal, this.#timings.cleanupCallTimeoutMs)),
        signal,
      );
      if (await this.#sandboxIsAbsent(sandbox.sandboxId, signal)) {
        return;
      }
    } catch (error) {
      directKillError = error;
    }

    try {
      await this.#killAndConfirmAbsent(sandbox.sandboxId, signal);
    } catch (fallbackError) {
      const errors =
        directKillError === undefined ? [fallbackError] : [directKillError, fallbackError];
      throw new AggregateError(
        errors,
        `failed to confirm E2B sandbox ${sandbox.sandboxId} cleanup: ${errors.map(errorMessage).join("; ")}`,
      );
    }
  }

  async #killAndConfirmAbsent(sandboxId: string, signal: AbortSignal): Promise<void> {
    for (const delayMs of this.#timings.cleanupRecoveryDelaysMs) {
      if (delayMs > 0) {
        signal.throwIfAborted();
        await raceWithSignal(this.#sleep(delayMs, signal), signal);
      }
      await this.#cleanupCall(
        (callSignal) =>
          this.#api.kill(sandboxId, cleanupOptions(callSignal, this.#timings.cleanupCallTimeoutMs)),
        signal,
      );
      if (await this.#sandboxIsAbsent(sandboxId, signal)) {
        return;
      }
    }
    throw new Error(`E2B sandbox ${sandboxId} still exists after repeated kill requests`);
  }

  async #sandboxIsAbsent(sandboxId: string, signal: AbortSignal): Promise<boolean> {
    try {
      await this.#cleanupCall(
        (callSignal) =>
          this.#api.getInfo(
            sandboxId,
            cleanupOptions(callSignal, this.#timings.cleanupCallTimeoutMs),
          ),
        signal,
      );
      return false;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        return true;
      }
      throw error;
    }
  }

  async #findSandboxes(
    metadata: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<SandboxInfo[]> {
    const paginator = this.#api.list({ limit: 100, query: { metadata: { ...metadata } } });
    const matches: SandboxInfo[] = [];
    while (paginator.hasNext) {
      matches.push(
        ...(await this.#cleanupCall(
          (callSignal) =>
            paginator.nextItems(cleanupOptions(callSignal, this.#timings.cleanupCallTimeoutMs)),
          signal,
        )),
      );
    }
    return matches;
  }

  async #cleanupCall<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    cleanupSignal: AbortSignal,
  ): Promise<T> {
    const callSignal = AbortSignal.any([
      cleanupSignal,
      AbortSignal.timeout(this.#timings.cleanupCallTimeoutMs),
    ]);
    callSignal.throwIfAborted();
    return await raceWithSignal(operation(callSignal), callSignal);
  }
}

function validateConfig(config: E2BExecutionConfig): E2BExecutionConfig {
  const image = normalizeE2BTemplateReference(config.image);
  const apiKey = config.credentials.apiKey.trim();
  const domain = normalizeE2BDomain(config.credentials.domain);
  if (!image || image === "base") {
    throw new Error("E2B execution requires a nonblank custom SelfBench template");
  }
  if (!apiKey) {
    throw new Error("E2B execution requires a nonblank API key");
  }
  return {
    kind: "e2b",
    image,
    timeoutCapMs: config.timeoutCapMs,
    credentials: { apiKey, ...(domain ? { domain } : {}) },
  };
}

function validateLifecycleTimings(timings: E2BLifecycleTimings): E2BLifecycleTimings {
  for (const [name, value] of Object.entries({
    cleanupCallTimeoutMs: timings.cleanupCallTimeoutMs,
    cleanupTimeoutMs: timings.cleanupTimeoutMs,
    commandKillGraceMs: timings.commandKillGraceMs,
    diagnosticTimeoutMs: timings.diagnosticTimeoutMs,
  })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`E2B lifecycle ${name} must be a positive integer`);
    }
  }
  if (
    timings.cleanupRecoveryDelaysMs.length === 0 ||
    timings.cleanupRecoveryDelaysMs.some((value) => !Number.isInteger(value) || value < 0)
  ) {
    throw new Error("E2B cleanup recovery delays must be nonnegative integers");
  }
  return timings;
}

function validateRequest(request: SandboxRequest): {
  readonly cpu: number;
  readonly memoryMiB: number;
} {
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 100) {
    throw new Error("sandbox timeout must be an integer of at least 100ms");
  }
  if (request.timeoutMs > MAX_E2B_TIMEOUT_MS) {
    throw new Error("E2B sandbox timeout cannot exceed 24 hours");
  }
  if (
    request.inactivityTimeoutMs !== undefined &&
    (!Number.isInteger(request.inactivityTimeoutMs) || request.inactivityTimeoutMs < 1)
  ) {
    throw new Error("sandbox inactivity timeout must be a positive integer");
  }
  if (request.command.length === 0 || !request.command[0]) {
    throw new Error("sandbox command must not be empty");
  }
  for (const path of [
    ...(request.files ?? []).map((file) => file.path),
    ...(request.outputPaths ?? []),
  ]) {
    assertWorkPath(path);
  }
  const cpu = request.cpu ?? 4;
  const memoryMiB = request.memoryMiB ?? 8192;
  if (!Number.isInteger(cpu) || cpu < 1) {
    throw new Error("E2B sandbox CPU must be a positive integer");
  }
  if (!Number.isInteger(memoryMiB) || memoryMiB < 1) {
    throw new Error("E2B sandbox memory must be a positive integer");
  }
  return { cpu, memoryMiB };
}

function validateAllocatedSandbox(
  sandboxId: string,
  info: Pick<
    SandboxInfo,
    "sandboxId" | "state" | "cpuCount" | "memoryMB" | "metadata" | "lifecycle"
  >,
  expected: { readonly cpu: number; readonly memoryMiB: number },
  metadata: Readonly<Record<string, string>>,
): void {
  if (info.sandboxId !== sandboxId) {
    throw new Error(`E2B returned sandbox info for ${info.sandboxId}; expected ${sandboxId}`);
  }
  if (info.state !== "running") {
    throw new Error(`E2B sandbox ${sandboxId} was created in unexpected state ${info.state}`);
  }
  if (info.lifecycle?.onTimeout !== "kill") {
    throw new Error(`E2B sandbox ${sandboxId} did not retain lifecycle onTimeout=kill`);
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (info.metadata[key] !== value) {
      throw new Error(`E2B sandbox ${sandboxId} did not retain allocation metadata ${key}`);
    }
  }
  if (info.cpuCount !== expected.cpu || info.memoryMB !== expected.memoryMiB) {
    throw new Error(
      `E2B template allocated ${info.cpuCount} CPU/${info.memoryMB} MiB for sandbox ${sandboxId}; expected ${expected.cpu} CPU/${expected.memoryMiB} MiB`,
    );
  }
}

function assertWorkPath(path: string): void {
  const normalized = posix.normalize(path);
  if (
    !path.startsWith(`${E2B_WORK_DIRECTORY}/`) ||
    !normalized.startsWith(`${E2B_WORK_DIRECTORY}/`)
  ) {
    throw new Error(`sandbox path must be beneath ${E2B_WORK_DIRECTORY}: ${path}`);
  }
}

async function collectPartialOutputs(
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
          sandbox.files.read(path, {
            format: "bytes",
            requestTimeoutMs,
            signal,
          }),
          signal,
        );
      } catch {
        // Partial outputs are best effort after timeout or infrastructure failure.
      }
    }),
  );
  return outputs;
}

function collectFailureResult(
  sandbox: E2BSandboxHandle,
  stdout: RollingOutput,
  stderr: RollingOutput,
  outputs: Record<string, Uint8Array>,
): SandboxResult {
  return {
    sandboxId: sandbox.sandboxId,
    exitCode: 1,
    stdout: stdout.text(),
    stderr: stderr.text(),
    outputs,
  };
}

function createErrorConfirmsNoAllocation(error: unknown): boolean {
  return error instanceof AuthenticationError || error instanceof InvalidArgumentError;
}

function cleanupOptions(
  signal: AbortSignal,
  requestTimeoutMs: number,
): Parameters<typeof Sandbox.kill>[1] {
  return {
    requestTimeoutMs,
    signal,
  };
}

async function waitForCommandKill(
  commandKill: Promise<boolean> | undefined,
  diagnosticSignal: AbortSignal,
  graceMs: number,
): Promise<void> {
  if (!commandKill) {
    return;
  }
  const signal = AbortSignal.any([diagnosticSignal, AbortSignal.timeout(graceMs)]);
  try {
    await raceWithSignal(commandKill, signal);
  } catch {
    // Sandbox cleanup remains the authoritative process/resource stop.
  }
}

function throwIfTerminated(error: unknown): void {
  if (error !== undefined) {
    throw error;
  }
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await delay(delayMs, undefined, { signal });
}

function attachCleanupError(primaryError: unknown, cleanupError: unknown): unknown {
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

function sanitizeCleanupError(error: unknown, redactedValue: string): Error {
  const sanitized = new Error(
    errorMessage(error).replaceAll(redactedValue, "[redacted]").slice(0, 1_000),
  );
  sanitized.name = "E2BSandboxCleanupError";
  return sanitized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
