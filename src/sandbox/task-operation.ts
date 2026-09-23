import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifierRuntimeFiles } from "../generation/harbor-task/runtime-assets.js";
import { projectRoot } from "../lib/project-paths.js";
import type { SandboxFile } from "./contracts.js";
import { taskSandbox } from "./task-context.js";

/** Runs trusted preparation code in a NEW allocation, never in the author's mutable sandbox. */
export async function taskOperation(
  operation: string,
  files: readonly SandboxFile[],
  outputPaths: readonly string[],
  signal?: AbortSignal,
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
    signal ? { signal } : {},
  );
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new Error(`Sandbox ${operation} failed (exit ${result.exitCode})`);
  return result.outputs;
}
