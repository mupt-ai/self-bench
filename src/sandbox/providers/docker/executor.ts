import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { SelfBenchConfig } from "../../../config.js";
import { runCommand } from "../../../process.js";
import type {
  SandboxExecResult,
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "../../contracts.js";
import { type LiveSandboxBacking, LiveSandboxRegistry } from "../../live.js";
import { readOutputWithRetry } from "../../output-retry.js";
import { attachCleanupFailure, supervisionFailure } from "../../ownership.js";
import { materializeRemoteFiles } from "../../remote-files.js";
import { validateSandboxRequest } from "../../request-validation.js";
import { cleanupDockerResources, DockerCleanupError } from "./cleanup.js";

export class DockerSandboxExecutor implements SandboxExecutor {
  readonly #config: Extract<SelfBenchConfig["execution"], { kind: "docker" }>;
  readonly #live = new LiveSandboxRegistry();

  constructor(config: Extract<SelfBenchConfig["execution"], { kind: "docker" }>) {
    this.#config = config;
  }

  async run(request: SandboxRequest, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    options.signal?.throwIfAborted();
    validateSandboxRequest(request);
    const root = await mkdtemp(join(tmpdir(), "selfbench-docker-"));
    const sandboxId = sandboxName(request.runId, request.stage);
    let outcome: SandboxResult | undefined;
    let primary: unknown;
    let failed = false;
    try {
      for (const file of await materializeRemoteFiles(request.files ?? [], options.signal)) {
        const destination = hostPath(root, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.contents);
      }

      const environment = { ...request.environment, ...request.secrets };
      const args = [
        "create",
        "--name",
        sandboxId,
        "--cpus",
        String(request.cpu ?? 4),
        "--memory",
        `${request.memoryMiB ?? 8192}m`,
        "--volume",
        `${sandboxId}:/work`,
        "--workdir",
        "/work",
      ];
      for (const key of Object.keys(environment)) {
        args.push("--env", key);
      }
      args.push(this.#config.image, ...request.command);

      await runCommand("docker", ["volume", "create", sandboxId]);
      await runCommand("docker", args, { env: { ...process.env, ...environment } });
      await runCommand("docker", ["cp", `${root}/.`, `${sandboxId}:/work/`]);

      const supervision = this.#live.start(sandboxId, dockerBacking(sandboxId, root), options);
      let commandOutcome:
        | { ok: true; result: Awaited<ReturnType<typeof runCommand>> }
        | { ok: false; error: unknown };
      try {
        const result = await runCommand("docker", ["start", "--attach", sandboxId], {
          allowFailure: true,
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: request.timeoutMs,
          ...(request.inactivityTimeoutMs
            ? { inactivityTimeoutMs: request.inactivityTimeoutMs }
            : {}),
          onOutput: (stream, chunk) => {
            options.onProgress?.({ stream, bytes: chunk.byteLength });
            options.onOutput?.(stream, chunk);
          },
        });
        commandOutcome = { ok: true, result };
      } catch (error) {
        commandOutcome = { ok: false, error };
      }
      try {
        await supervision.finish();
      } catch (hookError) {
        throw commandOutcome.ok ? hookError : supervisionFailure(commandOutcome.error, hookError);
      }
      if (!commandOutcome.ok) throw commandOutcome.error;
      const { result } = commandOutcome;
      const outputs: Record<string, Uint8Array> = {};
      for (const path of request.outputPaths ?? []) {
        const destination = hostPath(root, path);
        await mkdir(dirname(destination), { recursive: true });
        const { value } = await readOutputWithRetry(async () => {
          const copied = await runCommand("docker", ["cp", `${sandboxId}:${path}`, destination], {
            allowFailure: true,
          });
          return copied.exitCode === 0 ? await readFile(destination) : undefined;
        });
        if (value !== undefined) {
          outputs[path] = value;
        } else if (result.exitCode === 0) {
          throw new Error(`sandbox ${sandboxId} exited successfully without output ${path}`);
        }
      }
      outcome = { sandboxId, ...result, outputs };
    } catch (error) {
      primary = error;
      failed = true;
    }
    const failures: unknown[] = [];
    try {
      await cleanupDockerResources(sandboxId);
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      const cleanupError =
        failures.length === 1 && failures[0] instanceof DockerCleanupError
          ? failures[0]
          : new DockerCleanupError(sandboxId, failures);
      throw failed
        ? attachCleanupFailure(primary, cleanupError, {
            detail: `Docker sandbox cleanup also failed: ${cleanupError.message}`,
            aggregateMessage: "Docker sandbox execution and cleanup both failed",
          })
        : cleanupError;
    }
    if (failed) throw primary;
    if (!outcome) throw new Error("Docker execution returned no outcome");
    return outcome;
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

  close(): void {}
}

function dockerBacking(sandboxId: string, root: string): LiveSandboxBacking {
  const exchange = join(root, ".live");
  return {
    execute: async (command) =>
      await runCommand("docker", ["exec", sandboxId, ...command], { allowFailure: true }),
    readFile: async (path) => {
      const destination = join(exchange, `read-${crypto.randomUUID()}`);
      await mkdir(exchange, { recursive: true });
      const copied = await runCommand("docker", ["cp", `${sandboxId}:${path}`, destination], {
        allowFailure: true,
      });
      if (copied.exitCode !== 0) {
        return undefined;
      }
      try {
        return await readFile(destination);
      } finally {
        await rm(destination, { force: true });
      }
    },
    writeFile: async (path, contents) => {
      const source = join(exchange, `write-${crypto.randomUUID()}`);
      await mkdir(exchange, { recursive: true });
      await writeFile(source, contents);
      try {
        await runCommand("docker", ["cp", source, `${sandboxId}:${path}`]);
      } finally {
        await rm(source, { force: true });
      }
    },
  };
}

function hostPath(root: string, containerPath: string): string {
  if (!containerPath.startsWith("/work/")) {
    throw new Error(`sandbox path must be beneath /work: ${containerPath}`);
  }
  const path = resolve(root, relative("/work", containerPath));
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`sandbox path escapes /work: ${containerPath}`);
  }
  return path;
}

function sandboxName(runId: string, stage: string): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `selfbench-${runId.slice(0, 20)}-${stage.slice(0, 16)}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-");
}
