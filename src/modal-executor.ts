import { type Image, ModalClient, type Secret } from "modal";
import type { SelfBenchConfig } from "./config.js";
import { InactivityTimeoutError, RollingOutput } from "./process.js";
import {
  SandboxExecutionError,
  type SandboxExecutor,
  type SandboxRequest,
  type SandboxResult,
  type SandboxRunOptions,
} from "./sandbox.js";

export class ModalSandboxExecutor implements SandboxExecutor {
  readonly #client: ModalClient;
  readonly #config: Extract<SelfBenchConfig["execution"], { kind: "modal" }>;
  #image: Image | undefined;

  constructor(
    config: Extract<SelfBenchConfig["execution"], { kind: "modal" }>,
    client = new ModalClient(),
  ) {
    this.#config = config;
    this.#client = client;
  }

  async run(request: SandboxRequest, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    options.signal?.throwIfAborted();
    const app = await this.#client.apps.fromName(this.#config.app, {
      createIfMissing: true,
      ...(this.#config.environment ? { environment: this.#config.environment } : {}),
    });
    options.signal?.throwIfAborted();
    if (!this.#image) {
      this.#image = this.#buildImage();
    }
    const sandbox = await this.#client.sandboxes.create(app, this.#image, {
      timeoutMs: request.timeoutMs,
      idleTimeoutMs: Math.min(request.timeoutMs, 10 * 60 * 1000),
      cpu: request.cpu ?? 4,
      memoryMiB: request.memoryMiB ?? 8192,
      workdir: "/work",
      name: sandboxName(request.runId, request.stage),
      tags: { run_id: request.runId, stage: request.stage },
    });

    const abort = () => {
      void sandbox.terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      for (const file of request.files ?? []) {
        if (typeof file.contents === "string") {
          await sandbox.filesystem.writeText(file.contents, file.path);
        } else {
          await sandbox.filesystem.writeBytes(file.contents, file.path);
        }
      }

      const secrets = await this.#secrets(request.secrets);
      const process = await sandbox.exec([...request.command], {
        env: { ...request.environment },
        ...(secrets.length > 0 ? { secrets } : {}),
      });
      await process.closeStdin();
      const stdoutOutput = new RollingOutput();
      const stderrOutput = new RollingOutput();
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
      let inactivityError: InactivityTimeoutError | undefined;
      const clearInactivityTimer = (): void => {
        if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = undefined;
        }
      };
      const armInactivityTimer = (): void => {
        clearInactivityTimer();
        if (!request.inactivityTimeoutMs) {
          return;
        }
        inactivityTimer = setTimeout(() => {
          inactivityError = new InactivityTimeoutError(
            `Modal sandbox ${sandbox.sandboxId} stage ${request.stage}`,
            request.inactivityTimeoutMs ?? 0,
          );
          void sandbox.terminate();
        }, request.inactivityTimeoutMs);
        inactivityTimer.unref();
      };
      const consume = async (
        streamName: "stdout" | "stderr",
        stream: ReadableStream<string | Uint8Array>,
        output: RollingOutput,
      ): Promise<void> => {
        const reader = stream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              return;
            }
            if (value !== undefined) {
              const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
              output.push(chunk);
              options.onProgress?.({ stream: streamName, bytes: chunk.byteLength });
              armInactivityTimer();
            }
          }
        } finally {
          reader.releaseLock();
        }
      };
      armInactivityTimer();
      const settled = await Promise.allSettled([
        process.wait().catch((error: unknown) => {
          void sandbox.terminate();
          throw error;
        }),
        consume("stdout", process.stdout, stdoutOutput).catch((error: unknown) => {
          void sandbox.terminate();
          throw error;
        }),
        consume("stderr", process.stderr, stderrOutput).catch((error: unknown) => {
          void sandbox.terminate();
          throw error;
        }),
      ]).finally(clearInactivityTimer);
      const [processResult, ...streamResults] = settled;
      const rejectedStream = streamResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      const executionError =
        inactivityError ??
        (processResult.status === "rejected" ? processResult.reason : undefined) ??
        rejectedStream?.reason;
      const exitCode = processResult.status === "fulfilled" ? processResult.value : 1;
      const outputs: Record<string, Uint8Array> = {};
      for (const path of request.outputPaths ?? []) {
        try {
          outputs[path] = await sandbox.filesystem.readBytes(path);
        } catch {
          // Callers validate required outputs after persisting stdout/stderr. Returning an
          // absent output keeps the model or command failure diagnosable.
        }
      }
      const result = {
        sandboxId: sandbox.sandboxId,
        exitCode,
        stdout: stdoutOutput.text(),
        stderr: stderrOutput.text(),
        outputs,
      };
      if (executionError) {
        throw new SandboxExecutionError(
          `${executionError instanceof Error ? executionError.message : String(executionError)}; sandbox ${sandbox.sandboxId}`,
          result,
          { cause: executionError },
        );
      }
      return result;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await sandbox.terminate().catch(() => undefined);
    }
  }

  close(): void {
    this.#client.close();
  }

  #buildImage(): Image {
    return this.#client.images
      .fromRegistry(this.#config.image)
      .dockerfileCommands([
        "USER root",
        "RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl git jq ripgrep unzip xz-utils && rm -rf /var/lib/apt/lists/*",
        "RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.89.0/gh_2.89.0_linux_amd64.tar.gz -o /tmp/gh.tar.gz && echo 'd0422caade520530e76c1c558da47daebaa8e1203d6b7ff10ad7d6faba3490d8  /tmp/gh.tar.gz' | sha256sum -c - && tar -xzf /tmp/gh.tar.gz -C /tmp && mv /tmp/gh_2.89.0_linux_amd64/bin/gh /usr/local/bin/gh && rm -rf /tmp/gh.tar.gz /tmp/gh_2.89.0_linux_amd64",
        "RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.0",
        "RUN npm install --global @openai/codex@0.146.1",
        "ENV PATH=/root/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin",
        "WORKDIR /work",
      ]);
  }

  async #secrets(entries: Readonly<Record<string, string>> | undefined): Promise<Secret[]> {
    if (!entries || Object.keys(entries).length === 0) {
      return [];
    }
    return [
      await this.#client.secrets.fromObject(
        { ...entries },
        {
          ...(this.#config.environment ? { environment: this.#config.environment } : {}),
        },
      ),
    ];
  }
}

function sandboxName(runId: string, stage: string): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${runId.slice(0, 24)}-${stage.slice(0, 16)}-${suffix}`.replace(/[^a-zA-Z0-9._-]/g, "-");
}
