import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import type { ArtifactRef } from "../../contracts.js";
import {
  type VerifierRoundResult,
  verifierRoundResultSchema,
  verifyReportSchema,
} from "../../contracts.js";
import { PI_SESSION_OUTPUT_PATH, sessionArtifactKey } from "../../pi-session.js";
import type { SandboxExecutor, SandboxFile } from "../../sandbox/index.js";
import { loadPiModelAuth } from "../../subscription-auth.js";
import { renderVerifyReport } from "../../verify-report.js";
import { withAgentFeed } from "./agent-feed.js";
import { verifierRoundScript } from "./agent-scripts.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, VERIFIER_TIMEOUT_MS } from "./constants.js";
import { verifierPrompt } from "./prompts-verifier.js";
import { reconcileWrapperStatus, WRAPPER_STATUS_PATH } from "./round-outcome.js";
import {
  readAsset,
  runSandboxWithFailureLog,
  storePiSession,
  withActivityHeartbeats,
} from "./runtime.js";
import type { VerifierRoundInput } from "./types.js";
import { buildVerifierMaterial } from "./verifier-material.js";
import { resolveVerifierOutcome, VERDICT_PATH } from "./verifier-outcome.js";

/** Fresh read-only review of a mechanically green authoring revision. */
export async function runVerifierRound(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  _harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: VerifierRoundInput,
): Promise<VerifierRoundResult> {
  const { run, candidate, task, round } = input;
  const prefix = `runs/${run.runId}/verification/${candidate.candidateId}/round-${round}`;
  // Everything one attempt produces before the round is decided lives under attempt-<n>, so a
  // Temporal retry never collides with the immutable artifacts of the attempt it replaces.
  const attempt = Context.current().info.attempt;
  const attemptPrefix = `${prefix}/attempt-${attempt}`;
  const checkpoint = await store.getByKey(`${prefix}/result.json`);
  if (checkpoint) {
    return verifierRoundResultSchema.parse(JSON.parse(Buffer.from(checkpoint).toString("utf8")));
  }
  Context.current().heartbeat(`verifying ${task.taskId} round ${round}`);
  const [reportBytes, extension, program, piAuth] = await Promise.all([
    store.get(input.report),
    readAsset("dist/extension-verifier.bundle.js"),
    readAsset("dist/sandbox-verifier.bundle.js"),
    loadPiModelAuth(),
  ]);
  const report = verifyReportSchema.parse(JSON.parse(Buffer.from(reportBytes).toString("utf8")));
  if (!report.green) throw new Error("Read-only verification requires green mechanical checks");
  const material = await buildVerifierMaterial(store, task);
  await store.put(
    `${attemptPrefix}/coupling-evidence.json`,
    Buffer.from(JSON.stringify(material.couplingEvidence)),
    "application/json",
  );
  const prompt = verifierPrompt({
    taskId: task.taskId,
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
                timeoutMs: VERIFIER_TIMEOUT_MS,
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
                secrets: {
                  ...(piAuth.apiKey ? { OPENAI_API_KEY: piAuth.apiKey } : {}),
                  ...(piAuth.authJson ? { SELFBENCH_PI_AUTH_JSON: piAuth.authJson } : {}),
                },
                environment: {
                  AUTHOR_MODEL: run.authoring.model,
                  SELFBENCH_TASK_DIRECTORY: "/work/task/harbor-task",
                  SELFBENCH_REPO_DIRECTORY: "/work/repo",
                  SELFBENCH_VERDICT_OUTPUT: "/work/verdict",
                },
                command: ["bash", "-lc", verifierRoundScript(false)],
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
