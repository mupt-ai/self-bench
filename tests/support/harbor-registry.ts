import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HARBOR_VERSION } from "../../src/harnesses/harbor/command.js";
import type { CommandOptions, runCommand } from "../../src/lib/process.js";

/** A registry task as Harbor caches it: its package name, digest, and files. */
export interface PublishedTask {
  name: string;
  digest: string;
  files: Record<string, string>;
}

/** task.toml as Harbor serializes it, with its empty `env` and `mcp_servers` defaults. */
export function harborTaskToml(name: string, environment = ""): string {
  return `version = "1.0"

[task]
name = "${name}"

[metadata]
difficulty = "easy"

[verifier]
timeout_sec = 120.0

[agent]
timeout_sec = 120.0

[environment]
build_timeout_sec = 600.0
allow_internet = true
mcp_servers = []
${environment}
[verifier.env]

[solution.env]
`;
}

export function publishedTask(
  name: string,
  files: Record<string, string> = {},
  digest = "a".repeat(64),
): PublishedTask {
  return {
    name,
    digest,
    files: {
      "task.toml": harborTaskToml(name),
      "instruction.md": "Write hello.txt.\n",
      "environment/Dockerfile": "FROM ubuntu:24.04\nWORKDIR /app\n",
      "tests/test.sh": "#!/bin/bash\ntest -f /app/hello.txt\n",
      ...files,
    },
  };
}

/**
 * Stands in for the `harbor` CLI: `--version`, and `download <reference> --cache`, which writes
 * the reference's tasks where Harbor's cache keeps them under the HOME it is given. Every other
 * command runs for real.
 */
export function fakeHarbor(registry: Record<string, PublishedTask[]>, real: typeof runCommand) {
  const calls: { args: readonly string[]; env: CommandOptions["env"] }[] = [];
  const command: typeof runCommand = async (program, args, options = {}) => {
    if (program !== "harbor") return await real(program, args, options);
    calls.push({ args, env: options.env });
    if (args[0] === "--version") return { stdout: `${HARBOR_VERSION}\n`, stderr: "", exitCode: 0 };
    const tasks = registry[args[1] ?? ""];
    if (args[0] !== "download" || !tasks) throw new Error("harbor exited 1: not found");
    const cache = join(options.env?.HOME ?? "", ".cache", "harbor", "tasks", "packages");
    for (const task of tasks)
      for (const [path, text] of Object.entries(task.files)) {
        const file = join(cache, task.name, task.digest, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
      }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { command, calls };
}
