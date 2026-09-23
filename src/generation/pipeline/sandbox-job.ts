import { CompleteAsyncError, Context } from "@temporalio/activity";
import { signSandboxGrant } from "../../sandbox/callback-grant.js";
import type { SandboxExecutor, SandboxRequest, StartedSandbox } from "../../sandbox/index.js";
import type { SandboxJobOutcome } from "../../sandbox/jobs.js";
import { readAsset } from "./helpers.js";

export interface SandboxJob {
  readonly request: SandboxRequest;
  /** Files the job produces, each stored as `<prefix>/attempt-<n>/<name>`. */
  readonly outputs: readonly { name: string; path: string; contentType: string }[];
  /** A small JSON file returned inline as `result`. */
  readonly result?: string;
  readonly prefix: string;
}

/** Where sandboxes report back, and the secret the API checks their grants with. */
export interface SandboxCallback {
  readonly secret: string;
  readonly url: string;
}

const RUNNER = "/work/.selfbench-job.js";
const SPEC = "/work/.selfbench-job.json";

/**
 * Runs one job in a detached sandbox that reports through the callback API, so this activity
 * completes asynchronously: nothing on the worker waits on it and no output passes through the
 * worker. The API completes the activity with what the job uploaded.
 */
export async function runSandboxJob(
  sandbox: SandboxExecutor,
  job: SandboxJob,
  callback: SandboxCallback,
): Promise<SandboxJobOutcome> {
  const context = Context.current();
  const prefix = `${job.prefix}/attempt-${context.info.attempt}`;
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
