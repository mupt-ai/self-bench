import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { SelfBenchConfig } from "../../../config.js";
import { runCommand } from "../../../process.js";
import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "../../contracts.js";

export class DockerSandboxExecutor implements SandboxExecutor {
  readonly #config: Extract<SelfBenchConfig["execution"], { kind: "docker" }>;

  constructor(config: Extract<SelfBenchConfig["execution"], { kind: "docker" }>) {
    this.#config = config;
  }

  async run(request: SandboxRequest, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    const root = await mkdtemp(join(tmpdir(), "selfbench-docker-"));
    const sandboxId = sandboxName(request.runId, request.stage);
    try {
      for (const file of request.files ?? []) {
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

      const abort = () => {
        void runCommand("docker", ["rm", "--force", sandboxId], { allowFailure: true });
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await runCommand("docker", ["start", "--attach", sandboxId], {
          allowFailure: true,
          timeoutMs: request.timeoutMs,
          ...(request.inactivityTimeoutMs
            ? { inactivityTimeoutMs: request.inactivityTimeoutMs }
            : {}),
          onOutput: (stream, chunk) => options.onProgress?.({ stream, bytes: chunk.byteLength }),
        });
        const outputs: Record<string, Uint8Array> = {};
        for (const path of request.outputPaths ?? []) {
          const destination = hostPath(root, path);
          await mkdir(dirname(destination), { recursive: true });
          const copied = await runCommand("docker", ["cp", `${sandboxId}:${path}`, destination], {
            allowFailure: true,
          });
          if (copied.exitCode === 0) {
            outputs[path] = await readFile(destination);
          } else if (result.exitCode === 0) {
            throw new Error(`sandbox ${sandboxId} exited successfully without output ${path}`);
          }
        }
        return { sandboxId, ...result, outputs };
      } finally {
        options.signal?.removeEventListener("abort", abort);
        await runCommand("docker", ["rm", "--force", sandboxId], { allowFailure: true });
        await runCommand("docker", ["volume", "rm", "--force", sandboxId], {
          allowFailure: true,
        });
      }
    } finally {
      await runCommand("docker", ["rm", "--force", sandboxId], { allowFailure: true });
      await runCommand("docker", ["volume", "rm", "--force", sandboxId], {
        allowFailure: true,
      });
      await rm(root, { recursive: true, force: true });
    }
  }

  close(): void {}
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
