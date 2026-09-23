import { type Image, ModalClient, type Secret } from "modal";
import type { SelfBenchConfig } from "../../../config/index.js";
import type {
  SandboxExecResult,
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "../../contracts.js";
import { LiveSandboxRegistry } from "../../live.js";
import { materializeRemoteFiles } from "../../remote-files.js";
import { validateSandboxRequest } from "../../request-validation.js";
import { runModalCommand } from "./command.js";
import { ModalAllocation, ModalDeadline, withCleanupFailure } from "./lifecycle.js";

export class ModalSandboxExecutor implements SandboxExecutor {
  readonly #client: ModalClient;
  readonly #config: Extract<SelfBenchConfig["execution"], { kind: "modal" }>;
  readonly #live = new LiveSandboxRegistry();
  #image: Image | undefined;

  constructor(
    config: Extract<SelfBenchConfig["execution"], { kind: "modal" }>,
    client = new ModalClient(),
    private readonly cleanupTimeoutMs = 5_000,
  ) {
    this.#config = config;
    this.#client = client;
  }

  async run(request: SandboxRequest, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    options.signal?.throwIfAborted();
    validateSandboxRequest(request);
    const deadline = new ModalDeadline(request.timeoutMs, options.signal);
    const allocation = new ModalAllocation(
      this.#client,
      this.#config.app,
      sandboxName(request.runId, request.stage),
      this.#config.environment,
      this.cleanupTimeoutMs,
    );
    let result: SandboxResult | undefined;
    let primary: unknown;
    let failed = false;
    try {
      const app = await deadline.run(() =>
        this.#client.apps.fromName(this.#config.app, {
          createIfMissing: true,
          ...(this.#config.environment ? { environment: this.#config.environment } : {}),
        }),
      );
      this.#image ??= this.#buildImage();
      const image = this.#image;
      const sandbox = await deadline.run(() =>
        allocation.create(() =>
          this.#client.sandboxes.create(app, image, {
            timeoutMs: request.timeoutMs,
            idleTimeoutMs: Math.min(request.timeoutMs, 10 * 60 * 1000),
            cpu: request.cpu ?? 4,
            memoryMiB: request.memoryMiB ?? 8192,
            workdir: "/work",
            name: allocation.name,
            tags: { run_id: request.runId, stage: request.stage },
          }),
        ),
      );
      const files = await deadline.run(() =>
        materializeRemoteFiles(request.files ?? [], deadline.signal),
      );
      for (const file of files) {
        await deadline.run(() =>
          typeof file.contents === "string"
            ? sandbox.filesystem.writeText(file.contents, file.path)
            : sandbox.filesystem.writeBytes(file.contents, file.path),
        );
      }
      const secrets = await deadline.run(() => this.#secrets(request.secrets));
      result = await runModalCommand(sandbox, secrets, request, options, deadline, this.#live);
    } catch (error) {
      primary = error;
      failed = true;
    } finally {
      deadline.dispose();
    }
    // Cleanup has its own bounded grace, independent of caller cancellation. Total local
    // settlement is bounded by timeoutMs + 5s; SDK requests themselves may settle later.
    try {
      await allocation.cleanup();
    } catch (cleanupError) {
      throw failed ? withCleanupFailure(primary, cleanupError) : cleanupError;
    }
    if (failed) throw primary;
    if (!result) throw new Error("Modal execution completed without a result");
    return result;
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
  const suffix = crypto.randomUUID();
  return `${runId.slice(0, 16)}-${stage.slice(0, 8)}-${suffix}`.replace(/[^a-zA-Z0-9._-]/g, "-");
}
