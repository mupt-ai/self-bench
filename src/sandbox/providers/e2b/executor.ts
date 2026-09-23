import { CommandExitError, type CommandHandle, E2B } from "e2b";
import type { SelfBenchWorkerConfig } from "../../../contracts/config/index.js";
import { raceAbort, shellQuote } from "../../../lib/util.js";
import type { SandboxExecutor, SandboxRequest, SandboxRunOptions } from "../../contracts.js";
import { runSandbox, type SandboxSession } from "../../session.js";

type E2BExecutionConfig = Extract<SelfBenchWorkerConfig["execution"], { readonly kind: "e2b" }>;

// Creating from a large template can take well over 30 s; a short client timeout leaves E2B
// with a half-created sandbox and the worker with nothing.
const CREATE_REQUEST_TIMEOUT_MS = 120_000;
// The SDK shares one file transport; concurrent ~100 MB archive reads time out and restart.
const ARCHIVE_READ_LIMIT = 2;
const archiveReads = { active: 0, waiting: new Set<() => void>() };
// Small outputs the file API failed to return are re-read through the command channel.
const COMMAND_READ_MAX_BYTES = 1024 * 1024;
const COMMAND_READ_TIMEOUT_MS = 15_000;

/** E2B: a sandbox from the SelfBench template that E2B kills itself if we never get to. */
export class E2BSandboxExecutor implements SandboxExecutor {
  readonly #sandbox: E2B["Sandbox"];

  constructor(private readonly config: E2BExecutionConfig) {
    this.#sandbox = new E2B(config.credentials).Sandbox;
  }

  run(request: SandboxRequest, options?: SandboxRunOptions) {
    return runSandbox(() => this.open(request), request, options);
  }

  close(): void {}

  private async open(request: SandboxRequest): Promise<SandboxSession> {
    const sandbox = await this.#sandbox.create(this.config.image, {
      lifecycle: { onTimeout: "kill" },
      metadata: {
        selfbench_run: request.runId.slice(0, 256),
        selfbench_stage: request.stage.slice(0, 256),
      },
      requestTimeoutMs: Math.min(CREATE_REQUEST_TIMEOUT_MS, request.timeoutMs),
      timeoutMs: request.timeoutMs,
    });
    return {
      id: sandbox.sandboxId,
      write: async (path, contents) => {
        await sandbox.files.write(path, Uint8Array.from(contents).buffer);
      },
      read: async (path, signal = new AbortController().signal) => {
        const archive = path.endsWith(".tar.gz");
        if (archive) await acquireArchiveRead(signal);
        try {
          return await sandbox.files.read(path, { format: "bytes", signal });
        } catch {
          signal.throwIfAborted();
          // Never stream an archive through the command channel.
          return archive ? undefined : await readThroughCommand(sandbox, path, signal);
        } finally {
          if (archive) releaseArchiveRead();
        }
      },
      exec: async (command, { environment, signal, onOutput }) => {
        signal.throwIfAborted();
        const envs = Object.fromEntries(
          Object.entries(environment).filter(([key]) => !key.startsWith("E2B_")),
        );
        const starting = sandbox.commands.run(command.map(shellQuote).join(" "), {
          background: true,
          cwd: "/work",
          envs,
          onStdout: (data) => onOutput("stdout", Buffer.from(data)),
          onStderr: (data) => onOutput("stderr", Buffer.from(data)),
          timeoutMs: request.timeoutMs,
        });
        // A command that starts after the abort is killed as soon as it exists.
        const kill = (handle: CommandHandle) => void handle.kill().catch(() => undefined);
        void starting.then((handle) => signal.aborted && kill(handle)).catch(() => undefined);
        const handle = await raceAbort(starting, signal);
        const onAbort = () => kill(handle);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        try {
          return (await raceAbort(handle.wait(), signal)).exitCode;
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof CommandExitError) return error.exitCode;
          throw error;
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
      destroy: async () => {
        await sandbox.kill();
      },
    };
  }
}

async function acquireArchiveRead(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (archiveReads.active < ARCHIVE_READ_LIMIT) {
    archiveReads.active += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      archiveReads.waiting.delete(ready);
      reject(signal.reason);
    };
    archiveReads.waiting.add(ready);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Hands the slot straight to the next waiter, so the count never leaks. */
function releaseArchiveRead(): void {
  const next = archiveReads.waiting.values().next().value;
  if (next) {
    archiveReads.waiting.delete(next);
    next();
  } else archiveReads.active -= 1;
}

/** A bounded read of a small output through the command channel. */
async function readThroughCommand(
  sandbox: Awaited<ReturnType<E2B["Sandbox"]["create"]>>,
  path: string,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(COMMAND_READ_TIMEOUT_MS)]);
  try {
    const result = await raceAbort(
      sandbox.commands.run(
        `test -f ${shellQuote(path)} && head -c ${COMMAND_READ_MAX_BYTES + 1} ${shellQuote(path)} | base64 -w0`,
        { timeoutMs: COMMAND_READ_TIMEOUT_MS, requestTimeoutMs: COMMAND_READ_TIMEOUT_MS },
      ),
      bounded,
    );
    const bytes = Buffer.from(result.stdout, "base64");
    return bytes.length <= COMMAND_READ_MAX_BYTES ? bytes : undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}
