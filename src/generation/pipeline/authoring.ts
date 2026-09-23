import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { SelfBenchConfig } from "../../contracts/config/index.js";
import {
  type ArtifactRef,
  AUTHOR_VERIFY_BUDGET,
  type AuthoringRoundResult,
  type Candidate,
  DEFAULT_AUTHORING_ROUNDS,
  type RunRequest,
  verifyReportSchema,
} from "../../contracts/index.js";
import { errorMessage } from "../../lib/util.js";
import type { LiveSandbox, SandboxExecutor } from "../../sandbox/index.js";
import type { GenerationSettings } from "../settings/settings.js";
import { difficultyThresholds } from "../task/audit.js";
import { verifierRuntimeFiles } from "../task/runtime-assets.js";
import { runAgent } from "./agent.js";
import { readAsset } from "./helpers.js";
import { renderPrompt } from "./prompts.js";
import { compileAndVerify } from "./verify.js";
import { renderVerifyReport } from "./verify-report.js";

export interface AuthoringRoundInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly round: number;
  /** The previous round's session and verify report, for rounds after the first. */
  readonly session?: ArtifactRef;
  readonly report?: ArtifactRef;
  /** Reviewer suggestions for this round. */
  readonly feedback?: string;
}

const MAILBOX = "/work/mailbox";
const SUBMISSION = "/work/submission";

/**
 * One authoring round: pi writes the task, checks it with `verify` (the worker runs the full
 * compile + Harbor check for each request it finds in the sandbox mailbox), then submits.
 */
export async function runAuthoringRound(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: AuthoringRoundInput,
): Promise<AuthoringRoundResult> {
  const { run, candidate, round } = input;
  const roundPrefix = `runs/${run.runId}/authoring/${candidate.candidateId}/round-${round}`;
  const attempt = Context.current().info.attempt;
  const prefix = `${roundPrefix}/attempt-${attempt}`;
  const [provenance, extension, checker, session, report] = await Promise.all([
    store.get(candidate.provenance),
    readAsset("dist/extension-authoring.bundle.js"),
    readAsset("dist/sandbox-check.bundle.js"),
    input.session ? store.get(input.session) : undefined,
    input.report ? store.get(input.report) : undefined,
  ]);
  const verify = (definition: Uint8Array, bundle: Uint8Array, index: number) =>
    verifyDraft(
      store,
      sandbox,
      harborEnvironment,
      input,
      `${prefix}/verify-${index}`,
      definition,
      bundle,
    );
  const result = await runAgent({
    store,
    sandbox,
    run,
    label: `author-${candidate.candidateId}-r${round}`,
    prefix,
    sessionKey: `runs/${run.runId}/authoring/${candidate.candidateId}/session/round-${round}${attempt > 1 ? `-attempt-${attempt}` : ""}.jsonl`,
    ...(session ? { resume: session } : {}),
    workspace: { kind: "clone", commit: candidate.baseCommit },
    extension: "/work/authoring.js",
    tools: "read,bash,grep,find,ls,verify,submit_task",
    prompt: authoringPrompt(
      candidate,
      round,
      report &&
        renderVerifyReport(
          verifyReportSchema.parse(JSON.parse(Buffer.from(report).toString("utf8"))),
        ),
      input.feedback,
      run.generation?.settings,
    ),
    files: [
      ...Object.entries(verifierRuntimeFiles()).map(([path, contents]) => ({
        path: `/work/${path}`,
        contents,
      })),
      { path: "/work/authoring.js", contents: extension },
      { path: "/work/sandbox-check.js", contents: checker },
      { path: "/work/provenance.json", contents: provenance },
    ],
    outputs: [`${SUBMISSION}/definition.json`, `${SUBMISSION}/source-task.tar.gz`],
    environment: {
      SELFBENCH_DELIVERABLE: "/work/task",
      SELFBENCH_SUBMISSION: SUBMISSION,
      SELFBENCH_CHECK_PROGRAM: "/work/sandbox-check.js",
      SELFBENCH_MAILBOX: MAILBOX,
      SELFBENCH_VERIFY_BUDGET: String(AUTHOR_VERIFY_BUDGET),
    },
    timeoutMs: 4 * 60 * 60 * 1000,
    whileRunning: (live, exited) => answerVerifyRequests(live, exited, verify),
  });
  const definition = result.outputs[`${SUBMISSION}/definition.json`];
  const bundle = result.outputs[`${SUBMISSION}/source-task.tar.gz`];
  let outcome: AuthoringRoundResult;
  if (definition && bundle && result.session) {
    outcome = {
      kind: "submitted",
      task: await storeDraft(store, roundPrefix, candidate, definition, bundle),
      session: result.session,
    };
  } else if (result.exitCode !== 0 || result.providerError || !result.session) {
    // A crashed sandbox or model provider is retried by Temporal, not charged to the candidate.
    throw new Error(
      `authoring round ${round} ended without a submission (exit ${result.exitCode}${result.providerError ? `, provider: ${result.providerError.slice(0, 200)}` : ""}); log: ${result.log.uri}`,
    );
  } else {
    outcome = {
      kind: "rejected",
      candidateId: candidate.candidateId,
      reason: `authoring round ${round}: the agent submitted nothing${result.finalMessage ? `; agent said: ${result.finalMessage.slice(0, 1_000)}` : ""}; log: ${result.log.uri}`,
    };
  }
  await store.put(
    `${roundPrefix}/result.json`,
    Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`),
    "application/json",
  );
  return outcome;
}

/** Round 1 gets the full brief; later rounds resume the session with the report and any feedback. */
export function authoringPrompt(
  candidate: Candidate,
  round: number,
  report?: string,
  feedback?: string,
  settings?: Pick<GenerationSettings, "authoringRounds" | "verification">,
): string {
  const tiers = Object.entries(difficultyThresholds)
    .map(
      ([tier, t]) =>
        `${tier}: ≥${t.changedLines} changed implementation lines across ≥${t.implementationFiles} file${t.implementationFiles === 1 ? "" : "s"}, ≥${t.passToPass} pass-to-pass`,
    )
    .join("; ");
  const shared = {
    howToWork: renderPrompt("how-to-work", {
      verifyBudget: AUTHOR_VERIFY_BUDGET,
      round,
      rounds: settings?.authoringRounds ?? DEFAULT_AUTHORING_ROUNDS,
      verifyScope:
        settings?.verification === "static"
          ? "verify runs only the static checks (compiler, environment policy, audit); this run builds and runs nothing. Confirm by reading code, tests, and the repository's CI that the tests fail on the base and pass with gold.patch."
          : "verify is the test harness: it compiles the task and runs the real image build, smoke, nop, and oracle checks. Don't install dependencies or run test suites in this sandbox; read code and git history instead.",
    }),
    feedback: feedback ? renderPrompt("feedback", { feedback }) : "",
  };
  if (!report) {
    return renderPrompt("authoring", {
      ...shared,
      sourceUrl: candidate.sourceUrl,
      sourcePr: candidate.sourcePr,
      baseCommit: candidate.baseCommit,
      completedCommit: candidate.completedCommit,
      difficulty: candidate.difficulty,
      request: candidate.request,
      tiers,
    });
  }
  return renderPrompt("revision", {
    ...shared,
    reason: feedback
      ? "The reviewer requested revisions. The report below describes your latest tested draft, not a failed check."
      : "Your previous submission did not pass verification. Read the report below and address its failures.",
    report: report.trim(),
  });
}

async function storeDraft(
  store: ArtifactStore,
  prefix: string,
  candidate: Candidate,
  definition: Uint8Array,
  bundle: Uint8Array,
) {
  const parsed = JSON.parse(Buffer.from(definition).toString("utf8")) as { taskId?: unknown };
  const [definitionRef, bundleRef] = await Promise.all([
    store.put(`${prefix}/definition.json`, definition, "application/json"),
    store.put(`${prefix}/source-task.tar.gz`, bundle, "application/gzip"),
  ]);
  return {
    candidateId: candidate.candidateId,
    taskId:
      typeof parsed.taskId === "string" && parsed.taskId ? parsed.taskId : candidate.candidateId,
    definition: definitionRef,
    sourceBundle: bundleRef,
  };
}

/** Runs the full check on one in-session verify request and renders the report for the agent. */
async function verifyDraft(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: AuthoringRoundInput,
  prefix: string,
  definition: Uint8Array,
  bundle: Uint8Array,
): Promise<{ green: boolean; report: string }> {
  const task = await storeDraft(store, prefix, input.candidate, definition, bundle);
  const outcome = await compileAndVerify(
    store,
    sandbox,
    harborEnvironment,
    { run: input.run, candidate: input.candidate, task, stage: "authoring", round: input.round },
    prefix,
  );
  return { green: outcome.report.green, report: renderVerifyReport(outcome.report) };
}

/**
 * The worker side of `verify`: the tool writes `<mailbox>/<n>/{definition.json,source-task.tar.gz}`
 * then `ready`, and waits for `response.json`. Requests are numbered from 1 and answered in order.
 */
async function answerVerifyRequests(
  live: LiveSandbox,
  exited: AbortSignal,
  verify: (definition: Uint8Array, bundle: Uint8Array, index: number) => Promise<unknown>,
): Promise<void> {
  for (let index = 1; !exited.aborted; ) {
    const directory = `${MAILBOX}/${index}`;
    const ready = await live.readFile(`${directory}/ready`).catch(() => undefined);
    if (!ready) {
      await new Promise((resolve) => setTimeout(resolve, 5_000).unref());
      continue;
    }
    const [definition, bundle] = await Promise.all([
      live.readFile(`${directory}/definition.json`),
      live.readFile(`${directory}/source-task.tar.gz`),
    ]);
    let response: unknown;
    try {
      if (!definition || !bundle) throw new Error("verify request is incomplete");
      response = await verify(definition, bundle, index);
    } catch (error) {
      if (Context.current().cancellationSignal.aborted) throw error;
      response = { error: errorMessage(error) };
    }
    if (exited.aborted) return;
    await live.writeFile(`${directory}/response.json`, JSON.stringify(response));
    index += 1;
  }
}
