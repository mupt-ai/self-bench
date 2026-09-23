import { InactivityTimeoutError, RollingOutput } from "../lib/process.js";
import { errorMessage, raceAbort } from "../lib/util.js";
import {
  isRemoteSandboxFile,
  SandboxExecutionError,
  type SandboxRequest,
  type SandboxResult,
  type SandboxRunOptions,
} from "./contracts.js";
import { readOutputWithRetry } from "./output-retry.js";
import { remoteFileFetchScript } from "./remote-files.js";
import { validateSandboxRequest } from "./request-validation.js";

const HARD_TIMEOUT_EXIT_CODE = 124;

interface ExecOptions {
  readonly environment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly onOutput: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
}

/** What each provider implements: one allocated sandbox. */
export interface SandboxSession {
  readonly id: string;
  write(path: string, contents: Uint8Array): Promise<void>;
  /** Resolves undefined when the file does not exist. */
  read(path: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
  /** Runs a command in /work until it exits or `signal` aborts (then it must reject). */
  exec(command: readonly string[], options: ExecOptions): Promise<number>;
  destroy(): Promise<void>;
}

/**
 * The shared lifecycle every provider uses: allocate, stage files, run the command, collect
 * outputs, and always delete the sandbox. The hard deadline covers all of it; when it fires the
 * result is exit 124 with no outputs.
 */
export async function runSandbox(
  open: () => Promise<SandboxSession>,
  request: SandboxRequest,
  options: SandboxRunOptions = {},
): Promise<SandboxResult> {
  validateSandboxRequest(request);
  options.signal?.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("deadline")), request.timeoutMs);
  timer.unref();
  const signal = AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])]);
  const stdout = new RollingOutput();
  const stderr = new RollingOutput();
  const timedOut = (sandboxId: string): SandboxResult => ({
    sandboxId,
    exitCode: HARD_TIMEOUT_EXIT_CODE,
    stdout: stdout.text(),
    stderr: stderr.text(),
    outputs: {},
  });
  const opening = open();
  let session: SandboxSession;
  try {
    session = await raceAbort(opening, signal);
  } catch (error) {
    clearTimeout(timer);
    // A sandbox that finishes allocating after we gave up on it is still deleted.
    void opening.then((late) => late.destroy()).catch(() => undefined);
    if (options.signal?.aborted) throw options.signal.reason;
    if (deadline.signal.aborted) return timedOut("unallocated");
    throw error;
  }
  let failed = false;
  try {
    const result = await runInSession(session, request, options, signal, { stdout, stderr });
    if (deadline.signal.aborted && !options.signal?.aborted) return timedOut(session.id);
    return result;
  } catch (error) {
    if (deadline.signal.aborted && !options.signal?.aborted) return timedOut(session.id);
    failed = true;
    throw error;
  } finally {
    clearTimeout(timer);
    await session.destroy().catch((error: unknown) => {
      // A failed command already explains itself; a failed delete after success must surface.
      if (!failed)
        throw new Error(`could not delete sandbox ${session.id}: ${errorMessage(error)}`);
    });
  }
}

async function runInSession(
  session: SandboxSession,
  request: SandboxRequest,
  options: SandboxRunOptions,
  signal: AbortSignal,
  { stdout, stderr }: { stdout: RollingOutput; stderr: RollingOutput },
): Promise<SandboxResult> {
  for (const file of request.files ?? []) {
    signal.throwIfAborted();
    if (!isRemoteSandboxFile(file)) {
      const contents =
        typeof file.contents === "string" ? Buffer.from(file.contents) : file.contents;
      await raceAbort(session.write(file.path, contents), signal);
      continue;
    }
    const exit = await session.exec(["bash", "-lc", remoteFileFetchScript(file)], {
      environment: {},
      signal,
      onOutput: (_stream, chunk) => stderr.push(Buffer.from(chunk)),
    });
    if (exit !== 0) throw new Error(`sandbox ${session.id} could not fetch ${file.path}`);
  }

  const inactivity = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (!request.inactivityTimeoutMs) return;
    clearTimeout(idle);
    idle = setTimeout(
      () =>
        inactivity.abort(
          new InactivityTimeoutError(`sandbox ${session.id}`, request.inactivityTimeoutMs ?? 0),
        ),
      request.inactivityTimeoutMs,
    );
    idle.unref();
  };
  let exitCode: number | undefined;
  let failure: unknown;
  touch();
  try {
    exitCode = await session.exec(request.command, {
      environment: { ...request.environment, ...request.secrets },
      signal: AbortSignal.any([signal, inactivity.signal]),
      onOutput: (stream, chunk) => {
        (stream === "stdout" ? stdout : stderr).push(Buffer.from(chunk));
        options.onOutput?.(stream, chunk);
        touch();
      },
    });
  } catch (error) {
    failure = inactivity.signal.aborted ? inactivity.signal.reason : error;
  } finally {
    clearTimeout(idle);
  }
  // The deadline or the caller's cancel ends the run here; outputs are not collected.
  signal.throwIfAborted();

  const outputs: Record<string, Uint8Array> = {};
  for (const path of request.outputPaths ?? []) {
    const { value } = await readOutputWithRetry(() => session.read(path, signal), { signal });
    if (value) outputs[path] = value;
  }
  const result = (code: number): SandboxResult => ({
    sandboxId: session.id,
    exitCode: code,
    stdout: stdout.text(),
    stderr: stderr.text(),
    outputs,
  });
  if (failure !== undefined) {
    // The provider lost the command, but if every output is there the script had finished.
    const finished =
      (request.outputPaths ?? []).length > 0 &&
      (request.outputPaths ?? []).every((path) => outputs[path]);
    if (!finished) {
      throw new SandboxExecutionError(
        `${errorMessage(failure)}; sandbox ${session.id}`,
        result(-1),
        {
          cause: failure,
        },
      );
    }
    stderr.push(
      Buffer.from(
        `\n[selfbench] provider error after the command finished: ${errorMessage(failure)}\n`,
      ),
    );
    exitCode = 1;
  }
  const missing = (request.outputPaths ?? []).filter((path) => !outputs[path]);
  if (exitCode === 0 && missing.length > 0) {
    throw new SandboxExecutionError(
      `sandbox ${session.id} exited 0 without ${missing.join(", ")}`,
      result(0),
    );
  }
  return result(exitCode ?? 1);
}
