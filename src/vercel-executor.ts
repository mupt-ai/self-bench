import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { APIError, Sandbox } from "@vercel/sandbox";
import {
  isDigestPinnedOciImage,
  type SelfBenchWorkerConfig,
  type VercelCredentials,
} from "./config.js";
import { RollingOutput } from "./process.js";
import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "./sandbox.js";
import { executeVercelCommand, VERCEL_WORK_DIRECTORY } from "./vercel-command.js";
import { preventAmbiguousVercelCommandStartRetries } from "./vercel-fetch.js";

const CLEANUP_TIMEOUT_MS = 60_000;
const CLEANUP_RETRY_DELAY_MS = 1_000;
const CREATE_RATE_LIMIT_RETRIES = 2;
const CREATE_RATE_LIMIT_FALLBACK_DELAY_MS = 30_000;
const CREATE_RATE_LIMIT_MAX_DELAY_MS = 60_000;
const CREATE_REQUEST_TIMEOUT_MS = 60_000;
const HARD_TIMEOUT_EXIT_CODE = 124;
const LATE_CREATE_RECOVERY_DELAYS_MS = [0, 250, 750, 1_500] as const;

type VercelExecutionConfig = Extract<
  SelfBenchWorkerConfig["execution"],
  { readonly kind: "vercel" }
>;

type RunOutcome =
  | { readonly ok: true; readonly result: SandboxResult }
  | { readonly ok: false; readonly error: unknown };

type Sleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

class VercelHardTimeoutError extends Error {
  constructor(name: string, stage: string, timeoutMs: number) {
    super(`Vercel sandbox ${name} stage ${stage} exceeded ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export class VercelSandboxExecutor implements SandboxExecutor {
  readonly #config: VercelExecutionConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: Sleep;

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

    const deleteHandle = (): Promise<void> => {
      if (!sandbox) {
        return Promise.resolve();
      }
      deletePromise ??= sandbox.delete({ signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
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
      sandbox = await this.#createSandbox(
        name,
        tags,
        resources.vcpus,
        request.timeoutMs,
        controller.signal,
      );
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

      if (request.files && request.files.length > 0) {
        await session.writeFiles(
          request.files.map((file) => ({ path: file.path, content: file.contents })),
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
      await this.#cleanup(name, sandbox, deleteHandle);
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

  close(): void {}

  async #createSandbox(
    name: string,
    tags: Readonly<Record<string, string>>,
    vcpus: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Sandbox> {
    for (let retries = 0; ; retries += 1) {
      try {
        return await Sandbox.create({
          ...this.#config.credentials,
          fetch: this.#fetch,
          image: this.#config.image,
          name,
          persistent: false,
          resources: { vcpus },
          signal: withTimeout(signal, CREATE_REQUEST_TIMEOUT_MS),
          tags: { ...tags },
          timeout: timeoutMs,
        });
      } catch (error) {
        if (
          !(error instanceof APIError) ||
          error.response.status !== 429 ||
          retries >= CREATE_RATE_LIMIT_RETRIES
        ) {
          throw error;
        }
        await this.#sleep(createRetryDelayMs(error.response), signal);
      }
    }
  }

  async #cleanup(
    name: string,
    sandbox: Sandbox | undefined,
    deleteHandle: () => Promise<void>,
  ): Promise<void> {
    let directDeleteError: unknown;
    if (sandbox) {
      try {
        await deleteHandle();
        return;
      } catch (error) {
        directDeleteError = error;
      }
    }

    try {
      const recoveryDelays = sandbox ? [CLEANUP_RETRY_DELAY_MS] : LATE_CREATE_RECOVERY_DELAYS_MS;
      for (const delayMs of recoveryDelays) {
        if (delayMs > 0) {
          await this.#sleep(delayMs, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
        }
        let handle: Sandbox;
        try {
          handle = await Sandbox.get({
            ...this.#config.credentials,
            fetch: this.#fetch,
            name,
            resume: false,
            signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
          });
        } catch (error) {
          if (error instanceof APIError && error.response.status === 404) {
            continue;
          }
          throw error;
        }
        try {
          await handle.delete({ signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
        } catch (error) {
          if (error instanceof APIError && error.response.status === 404) {
            return;
          }
          throw error;
        }
        return;
      }
    } catch (recoveryError) {
      const errors =
        directDeleteError === undefined ? [recoveryError] : [directDeleteError, recoveryError];
      throw new AggregateError(
        errors,
        `failed to delete Vercel sandbox ${name}: ${errors.map(errorMessage).join("; ")}`,
      );
    }
  }
}

function validateConfig(config: VercelExecutionConfig): VercelExecutionConfig {
  const credentials: VercelCredentials = {
    token: config.credentials.token.trim(),
    teamId: config.credentials.teamId.trim(),
    projectId: config.credentials.projectId.trim(),
  };
  if (!credentials.token || !credentials.teamId || !credentials.projectId) {
    throw new Error("Vercel execution requires a complete nonblank credential triple");
  }
  const image = config.image.trim();
  if (!isDigestPinnedOciImage(image)) {
    throw new Error("Vercel execution requires a digest-pinned image");
  }
  return { kind: "vercel", credentials, image };
}

function validateRequest(request: SandboxRequest): {
  readonly vcpus: number;
  readonly memoryMiB: number;
} {
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 100) {
    throw new Error("sandbox timeout must be an integer of at least 100ms");
  }
  if (request.timeoutMs > 24 * 60 * 60 * 1_000) {
    throw new Error("Vercel sandbox timeout cannot exceed 24 hours");
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

  const vcpus = request.cpu ?? 4;
  if (!Number.isInteger(vcpus) || (vcpus !== 1 && (vcpus < 2 || vcpus > 32 || vcpus % 2 !== 0))) {
    throw new Error("Vercel sandbox CPU must be 1 or an even integer from 2 through 32");
  }
  const memoryMiB = request.memoryMiB ?? vcpus * 2048;
  if (memoryMiB !== vcpus * 2048) {
    throw new Error(
      `Vercel fixes memory at 2048 MiB per vCPU; ${vcpus} vCPU requires ${vcpus * 2048} MiB`,
    );
  }
  return { vcpus, memoryMiB };
}

function assertWorkPath(path: string): void {
  const normalized = posix.normalize(path);
  if (
    !path.startsWith(`${VERCEL_WORK_DIRECTORY}/`) ||
    !normalized.startsWith(`${VERCEL_WORK_DIRECTORY}/`)
  ) {
    throw new Error(`sandbox path must be beneath ${VERCEL_WORK_DIRECTORY}: ${path}`);
  }
}

function sandboxName(runId: string, stage: string): string {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const context = `${runId}-${stage}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const prefix = `selfbench-${context}`.slice(0, 128 - suffix.length - 1).replace(/-+$/g, "");
  return `${prefix}-${suffix}`;
}

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await delay(delayMs, undefined, { signal });
}

function createRetryDelayMs(response: Response): number {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) {
    return CREATE_RATE_LIMIT_FALLBACK_DELAY_MS;
  }
  const seconds = Number(header);
  const requestedDelay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(requestedDelay)) {
    return CREATE_RATE_LIMIT_FALLBACK_DELAY_MS;
  }
  return Math.min(CREATE_RATE_LIMIT_MAX_DELAY_MS, Math.max(0, Math.ceil(requestedDelay)));
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
    primaryError.message = `${primaryError.message}; Vercel sandbox cleanup also failed: ${cleanupMessage}`;
    Object.defineProperty(primaryError, "cleanupError", {
      configurable: true,
      value: cleanupError,
    });
    return primaryError;
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
