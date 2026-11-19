import { posix } from "node:path";
import { Daytona, Image, type Sandbox } from "@daytonaio/sdk";
import type { SelfBenchWorkerConfig } from "../../../contracts/config/index.js";
import { raceAbort, shellQuote, sleep } from "../../../lib/util.js";
import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxRunOptions,
  StartedSandbox,
} from "../../contracts.js";
import { parseSandboxDockerfile, readSandboxDockerfile } from "../../runtime-dockerfile.js";
import { runSandbox, type SandboxSession, startSandbox } from "../../session.js";

type DaytonaConfig = Extract<SelfBenchWorkerConfig["execution"], { readonly kind: "daytona" }>;
/** The part of Daytona's client the executor uses. */
export type DaytonaClient = Pick<Daytona, "create" | "get"> & Partial<AsyncDisposable>;

// The first sandbox builds Dockerfile.sandbox into a snapshot, which takes minutes; later ones reuse it.
const CREATE_TIMEOUT_MS = 20 * 60_000;
const DELETE_TIMEOUT_S = 60;
const EXIT_POLL_MS = 1_000;
// Daytona's default per-sandbox disk is too small for a cloned repository and its builds.
const DISK_GIB = 10;

/**
 * Daytona: an ephemeral sandbox built from the packaged Dockerfile.sandbox, which Daytona deletes
 * itself once the request's timeout passes. Auto-stop is off, since a detached command makes no
 * API calls to keep it alive.
 */
export class DaytonaSandboxExecutor implements SandboxExecutor {
  readonly #credentials: DaytonaConfig["credentials"];
  #client: DaytonaClient | undefined;
  #image: Image | undefined;

  constructor(config: DaytonaConfig, client?: DaytonaClient) {
    this.#credentials = config.credentials;
    this.#client = client;
  }

  /** Daytona's client connects as it is made, so it is made on first use. */
  get #daytona(): DaytonaClient {
    this.#client ??= new Daytona({ ...this.#credentials });
    return this.#client;
  }

  run(request: SandboxRequest, options?: SandboxRunOptions) {
    return runSandbox(() => this.open(request), request, options);
  }

  start(
    request: SandboxRequest,
    secretsFor?: (sandbox: StartedSandbox) => Readonly<Record<string, string>>,
  ) {
    return startSandbox(() => this.open(request), request, secretsFor);
  }

  async stop(sandbox: StartedSandbox): Promise<void> {
    const found = await this.#daytona.get(sandbox.sandboxId).catch(() => undefined);
    await found?.delete(DELETE_TIMEOUT_S);
  }

  /** Ends the client's event connection to Daytona. */
  close(): void {
    Promise.resolve(this.#client?.[Symbol.asyncDispose]?.()).catch(() => undefined);
  }

  private async open(request: SandboxRequest): Promise<SandboxSession> {
    this.#image ??= sandboxImage();
    const name = `selfbench-${`${request.runId}-${request.stage}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40)}-${crypto.randomUUID().slice(0, 12)}`;
    const sandbox = await this.#daytona.create(
      {
        image: this.#image,
        name,
        labels: {
          selfbench_run: request.runId.slice(0, 256),
          selfbench_stage: request.stage.slice(0, 256),
        },
        resources: {
          cpu: request.cpu ?? 4,
          memory: Math.ceil((request.memoryMiB ?? 8192) / 1024),
          disk: DISK_GIB,
        },
        ephemeral: true,
        autoStopInterval: 0,
        ttlMinutes: Math.ceil(request.timeoutMs / 60_000),
      },
      { timeout: Math.ceil(Math.min(CREATE_TIMEOUT_MS, request.timeoutMs) / 1000) },
    );
    const launch = async (
      command: readonly string[],
      environment: Readonly<Record<string, string>>,
    ) => {
      const session = crypto.randomUUID();
      await sandbox.process.createSession(session);
      const script = `cd /work && ${await stageEnvironment(sandbox, environment)}${command.map(shellQuote).join(" ")}`;
      const { cmdId } = await sandbox.process.executeSessionCommand(session, {
        command: `bash -c ${shellQuote(script)}`,
        runAsync: true,
      });
      if (!cmdId) throw new Error(`Daytona did not start a command in sandbox ${sandbox.id}`);
      return { session, cmdId };
    };
    return {
      id: sandbox.id,
      write: async (path, contents) => {
        await sandbox.process.executeCommand(`mkdir -p ${shellQuote(posix.dirname(path))}`);
        await sandbox.fs.uploadFile(Buffer.from(contents), path);
      },
      read: (path) => sandbox.fs.downloadFile(path).catch(() => undefined),
      exec: async (command, { environment, signal, onOutput }) => {
        const { session, cmdId } = await raceAbort(launch(command, environment), signal);
        // The log stream is only diagnostic: if it drops, the command's exit still decides.
        await raceAbort(
          sandbox.process
            .getSessionCommandLogs(
              session,
              cmdId,
              (chunk) => onOutput("stdout", Buffer.from(chunk)),
              (chunk) => onOutput("stderr", Buffer.from(chunk)),
            )
            .catch(() => undefined),
          signal,
        );
        for (;;) {
          const { exitCode } = await raceAbort(
            sandbox.process.getSessionCommand(session, cmdId),
            signal,
          );
          if (typeof exitCode === "number") return exitCode;
          await raceAbort(sleep(EXIT_POLL_MS), signal);
        }
      },
      // The session stays open: deleting it would end the command it started.
      spawn: async (command, environment) => {
        await launch(command, environment);
      },
      destroy: () => sandbox.delete(DELETE_TIMEOUT_S),
    };
  }
}

function sandboxImage(): Image {
  const { base, instructions } = parseSandboxDockerfile(readSandboxDockerfile());
  return Image.base(base).dockerfileCommands([...instructions]);
}

/**
 * Daytona's session commands take no environment, so it travels in a file the command sources
 * and removes, keeping secrets out of the command line.
 */
async function stageEnvironment(
  sandbox: Sandbox,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const entries = Object.entries(environment);
  if (entries.length === 0) return "";
  const lines = entries.map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(`invalid sandbox environment variable name: ${key}`);
    return `export ${key}=${shellQuote(value)}\n`;
  });
  const file = `/tmp/selfbench-env-${crypto.randomUUID()}`;
  await sandbox.fs.uploadFile(Buffer.from(lines.join("")), file);
  return `. ${file} && rm -f ${file} && `;
}
