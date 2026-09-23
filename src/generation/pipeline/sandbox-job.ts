import { CompleteAsyncError, Context } from "@temporalio/activity";
import { signSandboxGrant } from "../../sandbox/callback-grant.js";
import type { SandboxExecutor, SandboxRequest, StartedSandbox } from "../../sandbox/index.js";
import {
  JOB_DEADLINE_VARIABLE,
  JOB_SPEC_FILE,
  type JobSpec,
} from "../../sandbox/job-runner/spec.js";
import type { SandboxJobOutcome } from "../../sandbox/jobs.js";
import { readAsset } from "./helpers.js";

/** One command to run in a started sandbox, and what to report back when it ends. */
export interface SandboxJob extends Omit<JobSpec, "command"> {
  /** `timeoutMs` bounds the command; the sandbox lives a little longer to report. */
  readonly request: SandboxRequest;
  /** The artifact folder every upload lands in; unique per activity attempt. */
  readonly prefix: string;
}

/** Where sandboxes report back, and the secret the API checks their grants with. */
export interface SandboxCallback {
  readonly secret: string;
  readonly url: string;
}

const RUNNER = "/work/.selfbench-job.js";
const REPORTING_MS = 10 * 60_000;

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
  // A retry replaces the sandbox the previous attempt left behind.
  const previous = (context.info.heartbeatDetails as { sandbox?: StartedSandbox } | undefined)
    ?.sandbox;
  if (previous) await sandbox.stop(previous).catch(() => undefined);
  const { request, prefix, ...report } = job;
  const spec: JobSpec = { ...report, command: request.command };
  const started = await sandbox.start(
    {
      ...request,
      timeoutMs: request.timeoutMs + REPORTING_MS,
      command: ["node", RUNNER],
      files: [
        ...(request.files ?? []),
        { path: RUNNER, contents: await readAsset("dist/sandbox-job.bundle.js") },
        { path: `/work/${JOB_SPEC_FILE}`, contents: JSON.stringify(spec) },
      ],
    },
    (started) => ({
      // A provider cap may have shortened the sandbox; the command stops in time to report.
      [JOB_DEADLINE_VARIABLE]: new Date(Date.parse(started.expiresAt) - REPORTING_MS).toISOString(),
      SELFBENCH_JOB_CALLBACK_URL: callback.url,
      SELFBENCH_JOB_TOKEN: signSandboxGrant(
        {
          taskToken: Buffer.from(context.info.taskToken).toString("base64"),
          prefix,
          sandbox: started,
          // Outlives the sandbox so a late `done` is still accepted.
          expiresAt: Date.parse(started.expiresAt) + REPORTING_MS,
        },
        callback.secret,
      ),
    }),
  );
  context.heartbeat({ sandbox: started });
  throw new CompleteAsyncError();
}
