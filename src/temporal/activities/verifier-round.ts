import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts.js";
import {
  type AuthoredTaskDraft,
  type TaskDefinition,
  taskDefinitionSchema,
  type VerifierRoundResult,
  verifierRoundResultSchema,
  verifyReportSchema,
} from "../../contracts.js";
import {
  PI_RESUMED_SESSION_PATH,
  PI_SESSION_OUTPUT_PATH,
  sessionArtifactKey,
} from "../../pi-session.js";
import { runCommand } from "../../process.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import { loadPiModelAuth } from "../../subscription-auth.js";
import { assertVerifierFix } from "../../verifier-fix.js";
import { renderVerifyReport } from "../../verify-report.js";
import { verifierRoundScript } from "./agent-scripts.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, VERIFIER_TIMEOUT_MS } from "./constants.js";
import { verifierPrompt, verifierResumePrompt } from "./prompts-verifier.js";
import {
  readAsset,
  runSandboxWithFailureLog,
  type StoredPiSession,
  storePiSession,
  withActivityHeartbeats,
  withTaskBundle,
  withTemporaryDirectory,
} from "./runtime.js";
import type { VerifierRoundInput } from "./types.js";
import { buildVerifierMaterial } from "./verifier-material.js";

const FIX_DEFINITION_PATH = "/work/fix/fixed-definition.json";
const FIX_TEST_PATCH_PATH = "/work/fix/fixed-test.patch";
const VERDICT_PATH = "/work/verdict/verdict.json";

const verdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), reason: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal("fixed"), summary: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal("none") }),
]);

/**
 * One verification-agent round over a green task. Round 1 starts a fresh session that has never
 * seen the authoring conversation; later rounds resume that verifier session with the report for
 * its own fix. A fix is validated on the worker and re-materialized as a new submission.
 */
export async function runVerifierRound(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
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
  const [bundle, reportBytes, extension, program, checker, piAuth, sessionBytes] =
    await Promise.all([
      store.get(task.bundle),
      store.get(input.report),
      readAsset("src/extensions/verifier.ts"),
      readAsset("dist/sandbox-verifier.bundle.js"),
      readAsset("dist/sandbox-check.bundle.js"),
      loadPiModelAuth(),
      input.session ? store.get(input.session) : undefined,
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
  const logKey = `${prefix}/attempt-${Context.current().info.attempt}/sandbox.log`;
  const result = await runSandboxWithFailureLog(store, logKey, () =>
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
              { path: "/work/verifier.ts", contents: extension },
              { path: "/work/prompt.txt", contents: prompt },
              ...(sessionBytes ? [{ path: PI_RESUMED_SESSION_PATH, contents: sessionBytes }] : []),
            ],
            outputPaths: [
              VERDICT_PATH,
              FIX_DEFINITION_PATH,
              FIX_TEST_PATCH_PATH,
              PI_SESSION_OUTPUT_PATH,
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
            },
            command: ["bash", "-lc", verifierRoundScript(round > 1)],
          },
          options,
        ),
    ),
  );
  const log = await store.put(
    logKey,
    Buffer.from(`${result.stdout}\n${result.stderr}`),
    "text/plain",
  );
  const session = await storePiSession(
    store,
    sessionArtifactKey(run.runId, "verification", candidate.candidateId, round),
    result.outputs[PI_SESSION_OUTPUT_PATH],
  );
  const outcome = await resolveOutcome(store, input, prefix, result, session, log.uri);
  await store.put(
    `${prefix}/result.json`,
    Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`),
    "application/json",
  );
  return outcome;
}

async function resolveOutcome(
  store: ArtifactStore,
  input: VerifierRoundInput,
  prefix: string,
  result: { readonly exitCode: number; readonly outputs: Readonly<Record<string, Uint8Array>> },
  session: StoredPiSession | undefined,
  logUri: string,
): Promise<VerifierRoundResult> {
  const { candidate, round } = input;
  const reject = (reason: string): VerifierRoundResult => ({
    kind: "rejected",
    candidateId: candidate.candidateId,
    reason: `${reason}; log: ${logUri}`,
  });
  const verdictBytes = result.outputs[VERDICT_PATH];
  if (result.exitCode !== 0 || !verdictBytes || !session) {
    return reject(`verifier round ${round} did not complete${explanation(session)}`);
  }
  const verdict = verdictSchema.safeParse(JSON.parse(Buffer.from(verdictBytes).toString("utf8")));
  if (!verdict.success) {
    return reject(`verifier round ${round} produced an unreadable verdict`);
  }
  await store.put(`${prefix}/verdict.json`, verdictBytes, "application/json");
  if (verdict.data.kind === "none") {
    return reject(`verification agent declined the task${explanation(session)}`);
  }
  if (verdict.data.kind === "accepted") {
    return { kind: "accepted", session: session.ref, reason: verdict.data.reason };
  }
  const fixedDefinitionBytes = result.outputs[FIX_DEFINITION_PATH];
  const fixedTestPatchBytes = result.outputs[FIX_TEST_PATCH_PATH];
  if (!fixedDefinitionBytes || !fixedTestPatchBytes) {
    return reject(`verifier round ${round} recorded a fix without its files`);
  }
  try {
    const fixedTask = await materializeFix(
      store,
      input,
      prefix,
      Buffer.from(fixedDefinitionBytes).toString("utf8"),
      Buffer.from(fixedTestPatchBytes).toString("utf8"),
    );
    return { kind: "fixed", task: fixedTask, session: session.ref, summary: verdict.data.summary };
  } catch (error) {
    return reject(
      `verifier fix rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function materializeFix(
  store: ArtifactStore,
  input: VerifierRoundInput,
  prefix: string,
  fixedDefinitionJson: string,
  fixedTestPatch: string,
): Promise<AuthoredTaskDraft> {
  const fixed: TaskDefinition = taskDefinitionSchema.parse(JSON.parse(fixedDefinitionJson));
  const original = await withTaskBundle(store, input.task, async (taskDirectory) => {
    const [definitionBytes, testPatch, goldPatch] = await Promise.all([
      store.get(input.task.definition),
      readFile(join(taskDirectory, "tests/test.patch"), "utf8"),
      readFile(join(taskDirectory, "solution/gold.patch"), "utf8"),
    ]);
    return {
      definition: taskDefinitionSchema.parse(
        JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
      ),
      testPatch,
      goldPatch,
    };
  });
  assertVerifierFix({
    original: original.definition,
    fixed,
    originalTestPatch: original.testPatch,
    fixedTestPatch,
    originalGoldPatch: original.goldPatch,
    fixedGoldPatch: original.goldPatch,
  });
  const definitionBytes = Buffer.from(`${JSON.stringify(fixed, null, 2)}\n`);
  const sourceBundle = await withTemporaryDirectory("selfbench-fix-", async (root) => {
    const authored = join(root, "authored");
    await mkdir(authored);
    await Promise.all([
      writeFile(join(authored, "definition.json"), definitionBytes),
      writeFile(join(authored, "test.patch"), fixedTestPatch),
      writeFile(join(authored, "gold.patch"), original.goldPatch),
    ]);
    const archive = join(root, "source-task.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", authored, "."]);
    return await readFile(archive);
  });
  const [definitionRef, bundleRef] = await Promise.all([
    store.put(`${prefix}/fix/definition.json`, definitionBytes, "application/json"),
    store.put(`${prefix}/fix/source-task.tar.gz`, sourceBundle, "application/gzip"),
  ]);
  return {
    candidateId: input.candidate.candidateId,
    taskId: fixed.taskId,
    definition: definitionRef,
    sourceBundle: bundleRef,
  };
}

function explanation(session: StoredPiSession | undefined): string {
  return session?.finalMessage ? `: ${session.finalMessage.slice(0, 1_000)}` : "";
}
