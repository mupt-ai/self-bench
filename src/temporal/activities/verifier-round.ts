import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import {
  VERIFIER_VERIFY_BUDGET,
  type VerifierRoundResult,
  verifierRoundResultSchema,
  verifyReportSchema,
} from "../../contracts.js";
import {
  PI_RESUMED_SESSION_PATH,
  PI_SESSION_OUTPUT_PATH,
  sessionArtifactKey,
} from "../../pi-session.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import { MAILBOX_DIRECTORY } from "../../sandbox/supervisor.js";
import { loadPiModelAuth } from "../../subscription-auth.js";
import { renderVerifyReport } from "../../verify-report.js";
import { verifierRoundScript } from "./agent-scripts.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, VERIFIER_TIMEOUT_MS } from "./constants.js";
import { readOriginalTask } from "./drafts.js";
import { verifierPrompt, verifierResumePrompt } from "./prompts-verifier.js";
import { reconcileWrapperStatus, WRAPPER_STATUS_PATH } from "./round-outcome.js";
import {
  readAsset,
  runSandboxWithFailureLog,
  storePiSession,
  withActivityHeartbeats,
} from "./runtime.js";
import { SessionVerifier } from "./session-verify.js";
import type { VerifierRoundInput } from "./types.js";
import { buildVerifierMaterial } from "./verifier-material.js";
import {
  FIX_DEFINITION_PATH,
  FIX_TEST_PATCH_PATH,
  resolveVerifierOutcome,
  VERDICT_PATH,
} from "./verifier-outcome.js";

/**
 * One verification-agent round over a green task. Round 1 starts a fresh session that has never
 * seen the authoring conversation; later rounds resume that verifier session with the report for
 * its own fix. The agent can `verify` a fix in-session; a fix is validated on the worker and
 * re-materialized as a new submission.
 */
export async function runVerifierRound(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: VerifierRoundInput,
): Promise<VerifierRoundResult> {
  const { run, candidate, task, round } = input;
  const prefix = `runs/${run.runId}/verification/${candidate.candidateId}/round-${round}`;
  const checkpoint = await store.getByKey(`${prefix}/result.json`);
  if (checkpoint) {
    return verifierRoundResultSchema.parse(JSON.parse(Buffer.from(checkpoint).toString("utf8")));
  }
  if (round > 1 && !input.session) {
    throw ApplicationFailure.nonRetryable(
      `verifier round ${round} requires the previous session`,
      "InvalidVerifierRound",
    );
  }
  Context.current().heartbeat(`verifying ${task.taskId} round ${round}`);
  const [bundle, reportBytes, extension, program, checker, piAuth, sessionBytes, original] =
    await Promise.all([
      store.get(task.bundle),
      store.get(input.report),
      readAsset("dist/extension-verifier.bundle.js"),
      readAsset("dist/sandbox-verifier.bundle.js"),
      readAsset("dist/sandbox-check.bundle.js"),
      loadPiModelAuth(),
      input.session ? store.get(input.session) : undefined,
      readOriginalTask(store, task),
    ]);
  const rendered = renderVerifyReport(
    verifyReportSchema.parse(JSON.parse(Buffer.from(reportBytes).toString("utf8"))),
  );
  let prompt: string;
  if (round === 1) {
    const material = await buildVerifierMaterial(store, task);
    await store.put(
      `${prefix}/coupling-evidence.json`,
      Buffer.from(`${JSON.stringify(material.couplingEvidence, null, 2)}\n`),
      "application/json",
    );
    prompt = verifierPrompt({
      taskId: task.taskId,
      instruction: material.instruction,
      renderedReport: rendered,
      couplingEvidence: material.couplingEvidence,
      environment: material.definition.environment,
      testPatch: material.testPatch,
      goldPatch: material.goldPatch,
      heldOutPaths: material.heldOutPaths,
    });
  } else {
    prompt = verifierResumePrompt(round, rendered);
  }
  await store.put(`${prefix}/prompt.md`, Buffer.from(prompt), "text/markdown");
  // Everything one attempt produces before the round is decided lives under attempt-<n>, so a
  // Temporal retry never collides with the immutable artifacts of the attempt it replaces.
  const attempt = Context.current().info.attempt;
  const attemptPrefix = `${prefix}/attempt-${attempt}`;
  const verifier = new SessionVerifier({
    store,
    harborEnvironment,
    run,
    candidate,
    stage: "verification",
    round,
    prefix: attemptPrefix,
    original,
  });
  const verifyBudget = Math.max(0, VERIFIER_VERIFY_BUDGET - (input.verifyCallsUsed ?? 0));
  const logKey = `${attemptPrefix}/sandbox.log`;
  const sandboxResult = await runSandboxWithFailureLog(store, logKey, () =>
    withActivityHeartbeats(
      `running verifier sandbox for ${task.taskId} round ${round}`,
      (options) =>
        sandbox.run(
          {
            runId: run.runId,
            stage: `verify-${candidate.candidateId}-r${round}`,
            timeoutMs: VERIFIER_TIMEOUT_MS,
            inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
            files: [
              { path: "/work/task.tar.gz", contents: bundle },
              { path: "/work/sandbox-verifier.js", contents: program },
              { path: "/work/sandbox-check.js", contents: checker },
              { path: "/work/verifier.js", contents: extension },
              { path: "/work/prompt.txt", contents: prompt },
              ...(sessionBytes ? [{ path: PI_RESUMED_SESSION_PATH, contents: sessionBytes }] : []),
            ],
            outputPaths: [
              VERDICT_PATH,
              FIX_DEFINITION_PATH,
              FIX_TEST_PATCH_PATH,
              PI_SESSION_OUTPUT_PATH,
              WRAPPER_STATUS_PATH,
            ],
            secrets: {
              ...(piAuth.apiKey ? { OPENAI_API_KEY: piAuth.apiKey } : {}),
              ...(piAuth.authJson ? { SELFBENCH_PI_AUTH_JSON: piAuth.authJson } : {}),
            },
            environment: {
              AUTHOR_MODEL: run.authoring.model,
              SELFBENCH_CHECK_PROGRAM: "/work/sandbox-check.js",
              SELFBENCH_TASK_DIRECTORY: "/work/task/harbor-task",
              SELFBENCH_REPO_DIRECTORY: "/work/repo",
              SELFBENCH_FIX_OUTPUT: "/work/fix",
              SELFBENCH_VERDICT_OUTPUT: "/work/verdict",
              SELFBENCH_MAILBOX: MAILBOX_DIRECTORY,
              SELFBENCH_VERIFY_BUDGET: String(verifyBudget),
            },
            command: ["bash", "-lc", verifierRoundScript(round > 1)],
          },
          { ...options, onLive: (live, exited) => verifier.supervise(live, exited) },
        ),
    ),
  );
  const result = reconcileWrapperStatus(sandboxResult);
  const log = await store.put(
    logKey,
    Buffer.from(`${result.stdout}\n${result.stderr}`),
    "text/plain",
  );
  const session = await storePiSession(
    store,
    sessionArtifactKey(run.runId, "verification", candidate.candidateId, round, attempt),
    result.outputs[PI_SESSION_OUTPUT_PATH],
  );
  const outcome = await resolveVerifierOutcome({
    store,
    input,
    prefix,
    attemptPrefix,
    result,
    session,
    logUri: log.uri,
    original,
    verifier,
  });
  await store.put(
    `${prefix}/result.json`,
    Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`),
    "application/json",
  );
  return outcome;
}
