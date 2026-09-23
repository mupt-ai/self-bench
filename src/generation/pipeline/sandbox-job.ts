import { CompleteAsyncError, Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactRef } from "../../contracts/index.js";
import { signSandboxGrant } from "../../sandbox/callback-grant.js";
import type { SandboxExecutor, SandboxRequest, StartedSandbox } from "../../sandbox/index.js";
import { jobFileKey, type SandboxJobOutcome } from "../../sandbox/jobs.js";
import { readAsset, withHeartbeats } from "./helpers.js";

export interface SandboxJob {
  readonly request: SandboxRequest;
  /** Files the job produces, each stored as `<prefix>/attempt-<n>/<name>`. */
  readonly outputs: readonly { name: string; path: string; contentType: string }[];
  /** A small JSON file returned inline as `result`. */
  readonly result?: string;
  readonly prefix: string;
}

/** Where sandboxes report back; set when the API and the worker share a sandbox secret. */
export interface SandboxCallback {
  readonly secret: string;
  readonly url: string;
}

const RUNNER = "/work/.selfbench-job.js";
const SPEC = "/work/.selfbench-job.json";
const LOG = "job.log";

/**
 * Runs one job in a sandbox and returns what it produced. With a callback the sandbox is started
 * detached and reports through the API, so this activity completes asynchronously: nothing on the
 * worker waits on it and no output passes through the worker. Without one the job runs attached
 * and the worker stores the outputs itself.
 */
export async function runSandboxJob(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  job: SandboxJob,
  callback?: SandboxCallback,
): Promise<SandboxJobOutcome> {
  const context = Context.current();
  const prefix = `${job.prefix}/attempt-${context.info.attempt}`;
  if (!callback) return await runAttached(store, sandbox, job, prefix);
  // A retry replaces the sandbox the previous attempt left behind.
  const previous = (context.info.heartbeatDetails as { sandbox?: StartedSandbox } | undefined)
    ?.sandbox;
  if (previous) await sandbox.stop(previous).catch(() => undefined);
  const runner = await readAsset("dist/sandbox-job.bundle.js");
  const started = await sandbox.start(
    {
      ...job.request,
      command: ["node", RUNNER],
      files: [
        ...(job.request.files ?? []),
        { path: RUNNER, contents: runner },
        {
          path: SPEC,
          contents: JSON.stringify({
            command: job.request.command,
            outputs: job.outputs,
            ...(job.result ? { result: job.result } : {}),
          }),
        },
      ],
    },
    (started) => ({
      SELFBENCH_JOB_CALLBACK_URL: callback.url,
      SELFBENCH_JOB_TOKEN: signSandboxGrant(
        {
          taskToken: Buffer.from(context.info.taskToken).toString("base64"),
          prefix,
          sandbox: started,
          // Outlives the sandbox's own deadline so a late `done` is still accepted.
          expiresAt: Date.now() + job.request.timeoutMs + 60 * 60_000,
        },
        callback.secret,
      ),
    }),
  );
  context.heartbeat({ sandbox: started });
  throw new CompleteAsyncError();
}

async function runAttached(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  job: SandboxJob,
  prefix: string,
): Promise<SandboxJobOutcome> {
  const result = await withHeartbeats(`running ${job.request.stage}`, (options) =>
    sandbox.run(
      {
        ...job.request,
        outputPaths: [
          ...job.outputs.map((output) => output.path),
          ...(job.result ? [job.result] : []),
        ],
      },
      options,
    ),
  );
  const files: Record<string, ArtifactRef> = {};
  for (const output of job.outputs) {
    const bytes = result.outputs[output.path];
    if (bytes?.length) {
      files[output.name] = await store.put(
        jobFileKey(prefix, output.name),
        bytes,
        output.contentType,
      );
    }
  }
  files[LOG] = await store.put(
    jobFileKey(prefix, LOG),
    Buffer.from(`${result.stdout}\n${result.stderr}`),
    "text/plain",
  );
  const inline = job.result ? result.outputs[job.result] : undefined;
  return {
    exitCode: result.exitCode,
    files,
    ...(inline?.length ? { result: JSON.parse(Buffer.from(inline).toString("utf8")) } : {}),
  };
}
