import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifierRuntimeFiles } from "../generation/task/runtime-assets.js";
import { projectRoot } from "../lib/project-paths.js";
import { tail } from "../lib/util.js";
import type { SandboxFile, SandboxRunOptions } from "./contracts.js";
import { taskSandbox } from "./task-context.js";

/** Runs trusted preparation code in a NEW allocation, never in the author's mutable sandbox. */
export async function taskOperation(
  operation: string,
  files: readonly SandboxFile[],
  outputPaths: readonly string[],
  options: SandboxRunOptions = {},
) {
  const result = await taskSandbox().run(
    {
      runId: `task-${operation}`,
      stage: operation,
      timeoutMs: 30 * 60_000,
      command: ["node", "/work/task-operation.js", operation],
      files: [
        {
          path: "/work/task-operation.js",
          contents: await readFile(
            join(projectRoot(import.meta.url), "dist/sandbox-task-operation.bundle.js"),
          ),
        },
        ...Object.entries(verifierRuntimeFiles()).map(([path, contents]) => ({
          path: `/work/${path}`,
          contents,
        })),
        ...files,
      ],
      outputPaths,
    },
    options,
  );
  options.signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    const detail = tail(result.stderr.trim(), 2_000);
    throw new Error(
      `Sandbox ${operation} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}
