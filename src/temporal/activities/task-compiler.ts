import { z } from "zod";
import { verifierRuntimeFiles } from "../../harbor-task/runtime-assets.js";
import type { SandboxExecutor } from "../../sandbox/contracts.js";
import { taskSandbox } from "../../sandbox/task-context.js";
import { readAsset } from "./runtime.js";

export class TaskCompilerInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskCompilerInfrastructureError";
  }
}
export interface TaskCompilerInput {
  readonly taskId: string;
  readonly repositoryUrl: string;
  readonly definitionBytes: Uint8Array;
  readonly sourceBundle: Uint8Array;
  readonly token?: string;
  readonly signal?: AbortSignal;
}
const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), infrastructure: z.boolean(), message: z.string() }),
]);

/** Orchestration only: the worker never clones, checks out, or compiles repository content. */
export async function compileSubmittedTask(
  input: TaskCompilerInput,
  executor: SandboxExecutor = taskSandbox(),
): Promise<Uint8Array> {
  input.signal?.throwIfAborted();
  const result = await executor.run(
    {
      runId: input.taskId,
      stage: "trusted-compile",
      timeoutMs: 30 * 60_000,
      command: ["node", "/work/compiler.js"],
      files: [
        { path: "/work/compiler.js", contents: await readAsset("dist/sandbox-compiler.bundle.js") },
        ...Object.entries(verifierRuntimeFiles()).map(([path, contents]) => ({
          path: `/work/${path}`,
          contents,
        })),
        {
          path: "/work/input.json",
          contents: JSON.stringify({ taskId: input.taskId, repositoryUrl: input.repositoryUrl }),
        },
        { path: "/work/definition.json", contents: input.definitionBytes },
        { path: "/work/source-task.tar.gz", contents: input.sourceBundle },
      ],
      secrets: input.token ? { GH_TOKEN: input.token } : {},
      outputPaths: ["/work/result.json", "/work/compiled.tar.gz"],
    },
    input.signal ? { signal: input.signal } : {},
  );
  input.signal?.throwIfAborted();
  if (result.exitCode !== 0) throw new TaskCompilerInfrastructureError("Compiler sandbox failed");
  const bytes = result.outputs["/work/result.json"];
  if (!bytes) throw new TaskCompilerInfrastructureError("Compiler sandbox returned no report");
  const report = resultSchema.parse(JSON.parse(Buffer.from(bytes).toString()));
  if (!report.ok) {
    if (report.infrastructure) throw new TaskCompilerInfrastructureError(report.message);
    throw new Error(report.message);
  }
  const compiled = result.outputs["/work/compiled.tar.gz"];
  if (!compiled?.length)
    throw new TaskCompilerInfrastructureError("Compiler sandbox returned no bundle");
  return compiled;
}
