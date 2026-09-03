import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import {
  type ArtifactRef,
  AUTHOR_VERIFY_BUDGET,
  type AuthoringRoundResult,
  authoringRoundResultSchema,
  verifyReportSchema,
} from "../../contracts.js";
import {
  PI_RESUMED_SESSION_PATH,
  PI_SESSION_OUTPUT_PATH,
  sessionArtifactKey,
} from "../../pi-session.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import { MAILBOX_DIRECTORY } from "../../sandbox/supervisor.js";
import { githubToken, loadPiModelAuth } from "../../subscription-auth.js";
import { renderVerifyReport } from "../../verify-report.js";
import { authoringRoundScript } from "./agent-scripts.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, AUTHORING_TIMEOUT_MS } from "./constants.js";
import { authoringPrompt, authoringResumePrompt } from "./prompts-authoring.js";
import {
  archiveSandboxResult,
  classifyRound,
  piExitCodeFrom,
  reconcileWrapperStatus,
  SandboxOutputError,
  WRAPPER_STATUS_PATH,
} from "./round-outcome.js";
import {
  readAsset,
  runSandboxWithFailureLog,
  storePiSession,
  withActivityHeartbeats,
} from "./runtime.js";
import { SessionVerifier } from "./session-verify.js";
import { readSubmission } from "./submissions.js";
import type { AuthoringRoundInput } from "./types.js";

/**
 * One authoring round: a fresh pi session on round 1, or the previous round's session resumed with
 * the verification report as the next user turn. The deliverable is the complete task submission
 * (definition with environment contract, held-out test patch, gold patch) as a source bundle that
 * the trusted compiler renders on the worker.
 */
export async function runAuthoringRound(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: AuthoringRoundInput,
): Promise<AuthoringRoundResult> {
  const { run, candidate, round } = input;
  const prefix = `runs/${run.runId}/authoring/${candidate.candidateId}/round-${round}`;
  const checkpoint = await store.getByKey(`${prefix}/result.json`);
  if (checkpoint) {
    return authoringRoundResultSchema.parse(JSON.parse(Buffer.from(checkpoint).toString("utf8")));
  }
  if (round > 1 && (!input.session || !input.report)) {
    throw ApplicationFailure.nonRetryable(
      `authoring round ${round} requires the previous session and report`,
      "InvalidAuthoringRound",
    );
  }
  Context.current().heartbeat(`authoring ${candidate.candidateId} round ${round}`);
  const [
    provenance,
    extension,
    skill,
    packager,
    checker,
    piAuth,
    ghToken,
    sessionBytes,
    reportBytes,
  ] = await Promise.all([
    store.get(candidate.provenance),
    readAsset("dist/extension-authoring.bundle.js"),
    readAsset("src/skills/selfbench/SKILL.md"),
    readAsset("dist/sandbox-author.bundle.js"),
    readAsset("dist/sandbox-check.bundle.js"),
    loadPiModelAuth(),
    githubToken(),
    input.session ? store.get(input.session) : undefined,
    input.report ? store.get(input.report) : undefined,
  ]);
  const prompt = reportBytes
    ? authoringResumePrompt(
        round,
        renderVerifyReport(
          verifyReportSchema.parse(JSON.parse(Buffer.from(reportBytes).toString("utf8"))),
        ),
      )
    : authoringPrompt(run, candidate);
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
    stage: "authoring",
    round,
    prefix: attemptPrefix,
  });
  const verifyBudget = Math.max(0, AUTHOR_VERIFY_BUDGET - (input.verifyCallsUsed ?? 0));
  const logKey = `${attemptPrefix}/sandbox.log`;
  const sandboxResult = await runSandboxWithFailureLog(store, logKey, () =>
    withActivityHeartbeats(
      `running author sandbox for ${candidate.candidateId} round ${round}`,
      (options) =>
        sandbox.run(
          {
            runId: run.runId,
            stage: `author-${candidate.candidateId}-r${round}`,
            timeoutMs: AUTHORING_TIMEOUT_MS,
            inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
            files: [
              { path: "/work/authoring.js", contents: extension },
              { path: "/work/selfbench-skill/SKILL.md", contents: skill },
              { path: "/work/sandbox-author.js", contents: packager },
              { path: "/work/sandbox-check.js", contents: checker },
              { path: "/work/provenance.json", contents: provenance },
              { path: "/work/prompt.txt", contents: prompt },
              ...(sessionBytes ? [{ path: PI_RESUMED_SESSION_PATH, contents: sessionBytes }] : []),
            ],
            outputPaths: [
              "/work/source-task.tar.gz",
              "/work/definition.json",
              PI_SESSION_OUTPUT_PATH,
              WRAPPER_STATUS_PATH,
            ],
            secrets: {
              ...(piAuth.apiKey ? { OPENAI_API_KEY: piAuth.apiKey } : {}),
              ...(piAuth.authJson ? { SELFBENCH_PI_AUTH_JSON: piAuth.authJson } : {}),
              ...(ghToken ? { GH_TOKEN: ghToken } : {}),
            },
            environment: {
              SOURCE_REPO_URL: run.repository.url,
              SOURCE_COMMIT: candidate.baseCommit,
              AUTHOR_MODEL: run.authoring.model,
              SELFBENCH_TASK_OUTPUT: "/work/tasks",
              SELFBENCH_DELIVERABLE: "/work/task",
              SELFBENCH_CHECK_PROGRAM: "/work/sandbox-check.js",
              SELFBENCH_MAILBOX: MAILBOX_DIRECTORY,
              SELFBENCH_VERIFY_BUDGET: String(verifyBudget),
            },
            command: ["bash", "-lc", authoringRoundScript(round > 1)],
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
    sessionArtifactKey(run.runId, "authoring", candidate.candidateId, round, attempt),
    result.outputs[PI_SESSION_OUTPUT_PATH],
  );
  const bundle = result.outputs["/work/source-task.tar.gz"];
  const definitionBytes = result.outputs["/work/definition.json"];
  const missing = await archiveSandboxResult(
    store,
    `${attemptPrefix}/sandbox-result.json`,
    result,
    ["/work/source-task.tar.gz", "/work/definition.json", PI_SESSION_OUTPUT_PATH],
  );
  const verdict = classifyRound({
    round,
    exitCode: result.exitCode,
    piExitCode: piExitCodeFrom(result.stdout),
    missing: missing.filter((path) => path !== PI_SESSION_OUTPUT_PATH),
    sessionCollected: session !== undefined,
    toolCalls: session?.toolCalls ?? [],
    finalMessage: session?.finalMessage,
    providerError: session?.providerError,
  });
  if (verdict.kind === "infrastructure") {
    throw new SandboxOutputError(`authoring ${verdict.reason}; log: ${log.uri}`);
  }
  let outcome: AuthoringRoundResult;
  if (verdict.kind === "rejected" || !bundle || !definitionBytes || !session) {
    outcome = {
      kind: "rejected",
      candidateId: candidate.candidateId,
      reason: `authoring ${verdict.kind === "rejected" ? verdict.reason : `round ${round} produced no submission`}; log: ${log.uri}`,
    };
  } else {
    const [definitionRef, bundleRef] = await Promise.all([
      store.put(`${prefix}/definition.json`, definitionBytes, "application/json"),
      store.put(`${prefix}/source-task.tar.gz`, bundle, "application/gzip"),
    ]);
    const submission = await readSubmission(definitionBytes, bundle);
    const verified = submission
      ? verifier.verified(submission.definition, submission.testPatch, submission.goldPatch)
      : undefined;
    outcome = {
      kind: "submitted",
      task: {
        candidateId: candidate.candidateId,
        taskId: submission?.taskId ?? candidate.candidateId,
        definition: definitionRef,
        sourceBundle: bundleRef,
      },
      session: session.ref,
      verifyCalls: verifier.records.length,
      ...(verified ? { verified } : {}),
    };
  }
  await store.put(
    `${prefix}/result.json`,
    Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`),
    "application/json",
  );
  return outcome;
}
