import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SelfBenchConfig } from "../../../contracts/config/index.js";
import { runCommand } from "../../../lib/process.js";
import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxRunOptions,
  StartedSandbox,
} from "../../contracts.js";
import { runSandbox, type SandboxSession, startSandbox } from "../../session.js";

/** Local Docker: a sleeping container with a /work volume; commands run with `docker exec`. */
export class DockerSandboxExecutor implements SandboxExecutor {
  constructor(private readonly config: Extract<SelfBenchConfig["execution"], { kind: "docker" }>) {}

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
    await removeContainer(sandbox.sandboxId);
  }

  close(): void {}

  private async open(request: SandboxRequest): Promise<SandboxSession> {
    const name =
      `selfbench-${request.runId.slice(0, 20)}-${request.stage.slice(0, 16)}-${crypto.randomUUID().slice(0, 8)}`
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, "-");
    const scratch = await mkdtemp(join(tmpdir(), "selfbench-docker-"));
    const destroy = async () => {
      await removeContainer(name);
      await rm(scratch, { recursive: true, force: true });
    };
    try {
      await runCommand("docker", ["volume", "create", name]);
      await runCommand("docker", [
        "run",
        "--detach",
        "--name",
        name,
        "--cpus",
        String(request.cpu ?? 4),
        "--memory",
        `${request.memoryMiB ?? 8192}m`,
        "--volume",
        `${name}:/work`,
        "--workdir",
        "/work",
        "--entrypoint",
        "sleep",
        this.config.image,
        // A started sandbox nobody stops still ends with its timeout, like the hosted providers.
        String(Math.ceil(request.timeoutMs / 1000)),
      ]);
    } catch (error) {
      await destroy();
      throw error;
    }
    return {
      id: name,
      write: async (path, contents) => {
        const source = join(scratch, crypto.randomUUID());
        await writeFile(source, contents);
        await runCommand("docker", ["exec", name, "mkdir", "-p", dirname(path)]);
        await runCommand("docker", ["cp", source, `${name}:${path}`]);
        await rm(source, { force: true });
      },
      read: async (path) => {
        const destination = join(scratch, crypto.randomUUID());
        await mkdir(scratch, { recursive: true });
        const copied = await runCommand("docker", ["cp", `${name}:${path}`, destination], {
          allowFailure: true,
        });
        if (copied.exitCode !== 0) return undefined;
        try {
          return await readFile(destination);
        } finally {
          await rm(destination, { force: true });
        }
      },
      exec: async (command, { environment, signal, onOutput }) => {
        const args = ["exec", "--workdir", "/work"];
        for (const key of Object.keys(environment)) args.push("--env", key);
        const result = await runCommand("docker", [...args, name, ...command], {
          allowFailure: true,
          env: { ...process.env, ...environment },
          signal,
          onOutput,
        });
        return result.exitCode;
      },
      spawn: async (command, environment) => {
        const args = ["exec", "--detach", "--workdir", "/work"];
        for (const key of Object.keys(environment)) args.push("--env", key);
        await runCommand("docker", [...args, name, ...command], {
          env: { ...process.env, ...environment },
        });
        await rm(scratch, { recursive: true, force: true });
      },
      destroy,
    };
  }
}

async function removeContainer(name: string): Promise<void> {
  await runCommand("docker", ["rm", "--force", name], { allowFailure: true });
  await runCommand("docker", ["volume", "rm", "--force", name], { allowFailure: true });
}
