import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactRef } from "../../contracts/index.js";
import {
  type ReviewRoundResult,
  reviewRoundResultSchema,
  verifyReportSchema,
} from "../../contracts/index.js";
import { loadPiModelAuth, piModelAuthSecrets } from "../../pi/model-auth.js";
import { PI_SESSION_OUTPUT_PATH, sessionArtifactKey } from "../../pi/session.js";
import type { SandboxExecutor, SandboxFile } from "../../sandbox/index.js";
import {
  readAsset,
  runSandboxWithFailureLog,
  storePiSession,
  withActivityHeartbeats,
} from "../activity-runtime.js";
import type { ReviewRoundInput } from "../activity-types.js";
import { withAgentFeed } from "../agent/feed.js";
import { reconcileWrapperStatus, WRAPPER_STATUS_PATH } from "../agent/round-outcome.js";
import { reviewRoundScript } from "../agent/scripts.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, REVIEW_TIMEOUT_MS } from "../agent/timeouts.js";
import { renderVerifyReport } from "../verify/report.js";
import { buildReviewMaterial } from "./material.js";
import { resolveReviewOutcome, VERDICT_PATH } from "./outcome.js";
import { reviewPrompt } from "./prompt.js";

/** Fresh read-only review of a mechanically green authoring revision. */
export async function runReviewRound(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: ReviewRoundInput,
): Promise<ReviewRoundResult> {
  const { run, candidate, task, round } = input;
  const prefix = `runs/${run.runId}/review/${candidate.candidateId}/round-${round}`;
  // Everything one attempt produces before the round is decided lives under attempt-<n>, so a
  // Temporal retry never collides with the immutable artifacts of the attempt it replaces.
  const attempt = Context.current().info.attempt;
  const attemptPrefix = `${prefix}/attempt-${attempt}`;
  const checkpoint = await store.getByKey(`${prefix}/result.json`);
  if (checkpoint) {
    return reviewRoundResultSchema.parse(JSON.parse(Buffer.from(checkpoint).toString("utf8")));
  }
  Context.current().heartbeat(`reviewing ${task.taskId} round ${round}`);
  const [reportBytes, extension, program, piAuth] = await Promise.all([
    store.get(input.report),
    readAsset("dist/extension-reviewer.bundle.js"),
    readAsset("dist/sandbox-verifier.bundle.js"),
    loadPiModelAuth(),
  ]);
  const report = verifyReportSchema.parse(JSON.parse(Buffer.from(reportBytes).toString("utf8")));
  if (!report.green) throw new Error("Read-only review requires green mechanical checks");
  const material = await withActivityHeartbeats(`preparing reviewer ${task.taskId}`, ({ signal }) =>
    buildReviewMaterial(store, task, signal),
  );
  await store.put(
    `${attemptPrefix}/coupling-evidence.json`,
    Buffer.from(JSON.stringify(material.couplingEvidence)),
    "application/json",
  );
  const prompt = reviewPrompt({
    taskId: task.taskId,
    testSelection: material.definition.testSelection,
    testResults: material.definition.testResults,
    instruction: material.instruction,
    renderedReport: renderVerifyReport(report),
    couplingEvidence: material.couplingEvidence,
    environment: material.definition.environment,
    testPatch: material.testPatch,
    goldPatch: material.goldPatch,
    heldOutPaths: material.heldOutPaths,
  });
  await store.put(`${attemptPrefix}/prompt.md`, Buffer.from(prompt), "text/markdown");
  const logKey = `${attemptPrefix}/sandbox.log`;
  const sandboxResult = await withAgentFeed(
    store,
    attemptPrefix,
    [piAuth.apiKey ?? "", piAuth.authJson ?? ""],
    (onOutput) =>
      runSandboxWithFailureLog(store, logKey, () =>
        withActivityHeartbeats(
          `running verifier sandbox for ${task.taskId} round ${round}`,
          async (options) =>
            sandbox.run(
              {
                runId: run.runId,
                stage: `verify-${candidate.candidateId}-r${round}`,
                timeoutMs: REVIEW_TIMEOUT_MS,
                inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
                files: [
                  // The bundle (hundreds of MB) is pulled by the sandbox from a signed URL when the
                  // store can issue one; otherwise it is loaded inline, never held in a local.
                  await bundleFile(store, task.bundle),
                  { path: "/work/sandbox-verifier.js", contents: program },
                  { path: "/work/verifier.js", contents: extension },
                  { path: "/work/prompt.txt", contents: prompt },
                ],
                outputPaths: [VERDICT_PATH, PI_SESSION_OUTPUT_PATH, WRAPPER_STATUS_PATH],
                secrets: piModelAuthSecrets(piAuth),
                environment: {
                  AUTHOR_MODEL: run.authoring.model,
                  AUTHOR_PROVIDER: piAuth.provider,
                  AUTHOR_THINKING: run.authoring.reasoningEffort,
                  SELFBENCH_TASK_DIRECTORY: "/work/task/harbor-task",
                  SELFBENCH_REPO_DIRECTORY: "/work/repo",
                  SELFBENCH_VERDICT_OUTPUT: "/work/verdict",
                },
                command: ["bash", "-lc", reviewRoundScript(false)],
              },
              { ...options, onOutput },
            ),
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
    sessionArtifactKey(run.runId, "review", candidate.candidateId, round, attempt),
    result.outputs[PI_SESSION_OUTPUT_PATH],
  );
  const outcome = await resolveReviewOutcome({
    store,
    input,
    prefix,
    attemptPrefix,
    result,
    session,
    logUri: log.uri,
  });
  await store.put(
    `${prefix}/result.json`,
    Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`),
    "application/json",
  );
  return outcome;
}

const BUNDLE_URL_TTL_MS = 2 * 60 * 60_000;

async function bundleFile(store: ArtifactStore, bundle: ArtifactRef): Promise<SandboxFile> {
  try {
    const url = await store.signedReadUrl?.(bundle, BUNDLE_URL_TTL_MS);
    if (url) return { path: "/work/task.tar.gz", url, sha256: bundle.sha256 };
  } catch (error) {
    // Some ADC credentials can read GCS but cannot sign URLs. Inline fallback keeps verification
    // working; signed URLs remain the fast path for large bundles when a service account is present.
    if (!(error instanceof Error) || !/client_email|sign data|credential/i.test(error.message)) {
      throw error;
    }
  }
  return { path: "/work/task.tar.gz", contents: await store.get(bundle) };
}
