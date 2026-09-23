import { type Image, ModalClient } from "modal";
import type { SelfBenchConfig } from "../../../contracts/config/index.js";
import { raceAbort } from "../../../lib/util.js";
import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxRunOptions,
  StartedSandbox,
} from "../../contracts.js";
import { parseSandboxDockerfile, readSandboxDockerfile } from "../../runtime-dockerfile.js";
import { runSandbox, type SandboxSession, startSandbox } from "../../session.js";

type ModalConfig = Extract<SelfBenchConfig["execution"], { kind: "modal" }>;

/** Modal: a named sandbox in the configured app, built from the packaged Dockerfile.sandbox. */
export class ModalSandboxExecutor implements SandboxExecutor {
  #image: Image | undefined;

  constructor(
    private readonly config: ModalConfig,
    private readonly client = new ModalClient(),
  ) {}

  run(request: SandboxRequest, options?: SandboxRunOptions) {
    return runSandbox(() => this.open(request, true), request, options);
  }

  start(
    request: SandboxRequest,
    secretsFor?: (sandbox: StartedSandbox) => Readonly<Record<string, string>>,
  ) {
    // No idle timeout: nothing stays attached to a started command.
    return startSandbox(() => this.open(request, false), request, secretsFor);
  }

  async stop(sandbox: StartedSandbox): Promise<void> {
    const found = await this.client.sandboxes.fromId(sandbox.sandboxId).catch(() => undefined);
    await found?.terminate({ wait: true });
  }

  close(): void {
    this.client.close();
  }

  private async open(request: SandboxRequest, idle: boolean): Promise<SandboxSession> {
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
      ...(idle ? { idleTimeoutMs: Math.min(request.timeoutMs, 10 * 60 * 1000) } : {}),
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
      spawn: async (command, env) => {
        const secrets =
          Object.keys(env).length > 0
            ? [await this.client.secrets.fromObject({ ...env }, environment)]
            : [];
        const process = await sandbox.exec([...command], {
          stdout: "ignore",
          stderr: "ignore",
          ...(secrets.length > 0 ? { secrets } : {}),
        });
        await process.closeStdin();
      },
      destroy: async () => {
        await sandbox.terminate({ wait: true });
      },
    };
  }

  #buildImage(): Image {
    const { base, instructions } = parseSandboxDockerfile(readSandboxDockerfile());
    return this.client.images.fromRegistry(base).dockerfileCommands([...instructions]);
  }
}
