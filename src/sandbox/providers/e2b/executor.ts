import { CommandExitError, type CommandHandle, E2B } from "e2b";
import type { SelfBenchWorkerConfig } from "../../../contracts/config/index.js";
import { shellQuote } from "../../../lib/util.js";
import type { SandboxExecutor, SandboxRequest, SandboxRunOptions } from "../../contracts.js";
import { runSandbox, type SandboxSession } from "../../session.js";

type E2BExecutionConfig = Extract<SelfBenchWorkerConfig["execution"], { readonly kind: "e2b" }>;

// Creating from a large template can take well over 30 s; a short client timeout leaves E2B
// with a half-created sandbox and the worker with nothing.
const CREATE_REQUEST_TIMEOUT_MS = 120_000;
// The SDK shares one file transport; concurrent ~100 MB archive reads time out and restart.
const archiveReads = { active: 0, waiting: [] as (() => void)[] };

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
      read: async (path) => {
        const archive = path.endsWith(".tar.gz");
        if (archive) await acquireArchiveRead();
        try {
          return await sandbox.files.read(path, { format: "bytes" });
        } catch {
          return undefined;
        } finally {
          if (archive) releaseArchiveRead();
        }
      },
      exec: async (command, { environment, signal, onOutput }) => {
        signal.throwIfAborted();
        const envs = Object.fromEntries(
          Object.entries(environment).filter(([key]) => !key.startsWith("E2B_")),
        );
        const handle: CommandHandle = await sandbox.commands.run(
          command.map(shellQuote).join(" "),
          {
            background: true,
            cwd: "/work",
            envs,
            onStdout: (data) => onOutput("stdout", Buffer.from(data)),
            onStderr: (data) => onOutput("stderr", Buffer.from(data)),
            timeoutMs: request.timeoutMs,
          },
        );
        const kill = () => void handle.kill().catch(() => undefined);
        signal.addEventListener("abort", kill, { once: true });
        try {
          const result = await handle.wait();
          signal.throwIfAborted();
          return result.exitCode;
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof CommandExitError) return error.exitCode;
          throw error;
        } finally {
          signal.removeEventListener("abort", kill);
        }
      },
      destroy: async () => {
        await sandbox.kill();
      },
    };
  }
}

async function acquireArchiveRead(): Promise<void> {
  if (archiveReads.active < 2) {
    archiveReads.active += 1;
    return;
  }
  await new Promise<void>((resolve) => archiveReads.waiting.push(resolve));
}

function releaseArchiveRead(): void {
  const next = archiveReads.waiting.shift();
  if (next) next();
  else archiveReads.active -= 1;
}
