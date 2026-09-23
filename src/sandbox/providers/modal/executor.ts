import { type Image, ModalClient } from "modal";
import type { SelfBenchConfig } from "../../../contracts/config/index.js";
import { raceAbort } from "../../../lib/util.js";
import type { SandboxExecutor, SandboxRequest, SandboxRunOptions } from "../../contracts.js";
import { runSandbox, type SandboxSession } from "../../session.js";

type ModalConfig = Extract<SelfBenchConfig["execution"], { kind: "modal" }>;

/** Modal: a named sandbox in the configured app, built from the configured base image. */
export class ModalSandboxExecutor implements SandboxExecutor {
  #image: Image | undefined;

  constructor(
    private readonly config: ModalConfig,
    private readonly client = new ModalClient(),
  ) {}

  run(request: SandboxRequest, options?: SandboxRunOptions) {
    return runSandbox(() => this.open(request), request, options);
  }

  close(): void {
    this.client.close();
  }

  private async open(request: SandboxRequest): Promise<SandboxSession> {
    const environment = this.config.environment ? { environment: this.config.environment } : {};
    const app = await this.client.apps.fromName(this.config.app, {
      createIfMissing: true,
      ...environment,
    });
    this.#image ??= this.#buildImage();
    const name =
      `${request.runId.slice(0, 16)}-${request.stage.slice(0, 8)}-${crypto.randomUUID()}`.replace(
        /[^a-zA-Z0-9._-]/g,
        "-",
      );
    const sandbox = await this.client.sandboxes.create(app, this.#image, {
      timeoutMs: request.timeoutMs,
      idleTimeoutMs: Math.min(request.timeoutMs, 10 * 60 * 1000),
      cpu: request.cpu ?? 4,
      memoryMiB: request.memoryMiB ?? 8192,
      workdir: "/work",
      name,
      tags: { run_id: request.runId, stage: request.stage },
    });
    return {
      id: sandbox.sandboxId,
      write: (path, contents) => sandbox.filesystem.writeBytes(contents, path),
      read: (path) => sandbox.filesystem.readBytes(path).catch(() => undefined),
      exec: async (command, { environment: env, signal, onOutput }) => {
        const secrets =
          Object.keys(env).length > 0
            ? [await this.client.secrets.fromObject({ ...env }, environment)]
            : [];
        const process = await sandbox.exec([...command], secrets.length > 0 ? { secrets } : {});
        await process.closeStdin();
        const pump = async (
          stream: ReadableStream<string | Uint8Array>,
          name: "stdout" | "stderr",
        ) => {
          const reader = stream.getReader();
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            onOutput(name, typeof next.value === "string" ? Buffer.from(next.value) : next.value);
          }
        };
        // On abort the session deletes the sandbox next, which ends the process.
        const [exitCode] = await raceAbort(
          Promise.all([
            process.wait(),
            pump(process.stdout, "stdout"),
            pump(process.stderr, "stderr"),
          ]),
          signal,
        );
        return exitCode;
      },
      destroy: async () => {
        await sandbox.terminate({ wait: true });
      },
    };
  }

  #buildImage(): Image {
    return this.client.images
      .fromRegistry(this.config.image)
      .dockerfileCommands([
        "USER root",
        "RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl git jq ripgrep unzip xz-utils && rm -rf /var/lib/apt/lists/*",
        "RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.89.0/gh_2.89.0_linux_amd64.tar.gz -o /tmp/gh.tar.gz && echo 'd0422caade520530e76c1c558da47daebaa8e1203d6b7ff10ad7d6faba3490d8  /tmp/gh.tar.gz' | sha256sum -c - && tar -xzf /tmp/gh.tar.gz -C /tmp && mv /tmp/gh_2.89.0_linux_amd64/bin/gh /usr/local/bin/gh && rm -rf /tmp/gh.tar.gz /tmp/gh_2.89.0_linux_amd64",
        "RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.0",
        "ENV PATH=/root/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin",
        "WORKDIR /work",
      ]);
  }
}
