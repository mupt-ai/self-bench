import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts/index.js";
import {
  type ArtifactRef,
  AUTHOR_VERIFY_BUDGET,
  type AuthoredTaskDraft,
  type AuthoringTurnResult,
  type Candidate,
  MAX_AUTHORING_ROUNDS,
  type RunRequest,
  type VerifyReport,
  verifyReportSchema,
} from "../../contracts/index.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import type { SandboxJobOutcome } from "../../sandbox/jobs.js";
import { difficultyThresholds } from "../task/audit.js";
import { TASK_LIMITS } from "../task/render.js";
import { finishAgent, startAgent } from "./agent.js";
import { artifactFile, readAsset } from "./helpers.js";
import { renderPrompt } from "./prompts.js";
import type { SandboxCallback } from "./sandbox-job.js";
import { taskSourceEnvironment } from "./task-source.js";
import { renderVerifyReport } from "./verify-report.js";

export interface AuthoringTurnInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly round: number;
  /** Turns within a round, from 1; every turn after the first follows one `verify`. */
  readonly turn: number;
  /** The conversation so far, resumed in this turn's fresh sandbox. */
  readonly session?: ArtifactRef;
  /** The latest draft, restored into /work/task. */
  readonly draft?: AuthoredTaskDraft;
  /** Turn 1: the previous round's report. Later turns: the report of the verify just run. */
  readonly report?: ArtifactRef;
  /** Reviewer suggestions for this round (turn 1 only). */
  readonly feedback?: string;
  /** A revision's first turn: what a person asked to change in the task restored at /work/task. */
  readonly maintainerFeedback?: string;
  readonly verifiesLeft: number;
}

const SUBMISSION = "/work/submission";
const VERIFY_REQUEST = "/work/verify";
const DRAFT = "/work/draft.tar.gz";
const RESTORE_DRAFT = `mkdir -p /work/task && tar -xzf ${DRAFT} -C /work/task`;
/** A scenario's attached files, as the API packed them (scenario-request.ts). */
const ATTACHMENTS = "/work/attachments.tar.gz";
const UNPACK_ATTACHMENTS = `mkdir -p /work/attachments && tar -xzf ${ATTACHMENTS} --no-same-owner -C /work/attachments`;

/**
 * The round's outcome: the submission, or why the round delivered nothing. Tools that package
 * accepted tasks (tools/build-combined-bundle.ts) read it; per-turn results sit beside it.
 */
export function authoringRoundResultKey(runId: string, candidateId: string, round: number) {
  return `runs/${runId}/authoring/${candidateId}/round-${round}/result.json`;
}

export interface FinishAuthoringTurnInput extends AuthoringTurnInput {
  readonly outcome: SandboxJobOutcome;
}

const HAND_OFFS = [
  { kind: "submitted", bundle: `${SUBMISSION}/source-task.tar.gz` },
  { kind: "verify", bundle: `${VERIFY_REQUEST}/source-task.tar.gz` },
] as const;

function turnPrefix({ run, candidate, round, turn }: AuthoringTurnInput): string {
  return `runs/${run.runId}/authoring/${candidate.candidateId}/round-${round}/turn-${turn}`;
}

/**
 * One authoring turn: pi works on the task in a fresh sandbox until it calls `verify` or
 * `submit_task`, both of which end the turn. The sandbox reports back through the callback API;
 * `finishAuthoringTurn` reads what it handed off. A turn that crashed without handing anything
 * off fails in the sandbox, so Temporal retries it without charging the candidate.
 */
export async function startAuthoringTurn(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  callback: SandboxCallback,
  input: AuthoringTurnInput,
): Promise<SandboxJobOutcome> {
  const { run, candidate, round, turn } = input;
  const attempt = Context.current().info.attempt;
  const attachments = candidate.kind === "scenario" ? candidate.attachments : undefined;
  const [provenance, extension, checker, report, draft, attached] = await Promise.all([
    store.get(candidate.provenance),
    readAsset("dist/extension-authoring.bundle.js"),
    readAsset("dist/sandbox-check.bundle.js"),
    input.report ? store.get(input.report) : undefined,
    input.draft ? artifactFile(store, input.draft.sourceBundle, DRAFT) : undefined,
    attachments ? artifactFile(store, attachments, ATTACHMENTS) : undefined,
  ]);
  const setup = [draft ? RESTORE_DRAFT : "", attached ? UNPACK_ATTACHMENTS : ""]
    .filter(Boolean)
    .join("\n");
  const verifyReport =
    report && verifyReportSchema.parse(JSON.parse(Buffer.from(report).toString("utf8")));
  return await startAgent({
    store,
    sandbox,
    callback,
    run,
    label: `author-${candidate.candidateId}-r${round}-t${turn}`,
    prefix: `${turnPrefix(input)}/attempt-${attempt}`,
    record: { stage: "authoring", round, turn, attempt },
    ...(input.session ? { resume: input.session } : {}),
    workspace: candidate.baseCommit
      ? { kind: "clone", commit: candidate.baseCommit }
      : { kind: "scenario" },
    ...(setup ? { setup } : {}),
    extension: "/work/authoring.js",
    tools: "read,bash,grep,find,ls,verify,submit_task",
    prompt:
      turn === 1
        ? authoringPrompt(
            candidate,
            round,
            verifyReport && renderVerifyReport(verifyReport),
            input.feedback,
            input.maintainerFeedback,
          )
        : verifyResultPrompt(verifyReport, input.verifiesLeft),
    files: [
      { path: "/work/authoring.js", contents: extension },
      { path: "/work/sandbox-check.js", contents: checker },
      { path: "/work/provenance.json", contents: provenance },
      ...(draft ? [draft] : []),
      ...(attached ? [attached] : []),
    ],
    outputs: HAND_OFFS.map(({ bundle }) => bundle),
    delivers: HAND_OFFS.map(({ bundle }) => [bundle]),
    environment: {
      SELFBENCH_DELIVERABLE: "/work/task",
      ...taskSourceEnvironment(candidate),
      SELFBENCH_DIFFICULTY: candidate.difficulty,
      SELFBENCH_SUBMISSION: SUBMISSION,
      SELFBENCH_VERIFY_REQUEST: VERIFY_REQUEST,
      SELFBENCH_CHECK_PROGRAM: "/work/sandbox-check.js",
      SELFBENCH_VERIFY_BUDGET: String(input.verifiesLeft),
    },
    timeoutMs: 4 * 60 * 60 * 1000,
  });
}

/** Stops the turn's sandbox and turns what the agent handed off into the turn's result. */
export async function finishAuthoringTurn(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: FinishAuthoringTurnInput,
): Promise<AuthoringTurnResult> {
  const { run, candidate, round } = input;
  const result = await finishAgent(store, sandbox, input.outcome);
  // The extension blocks every tool call after the first hand-off, so at most one is present.
  const handOff = HAND_OFFS.map(({ kind, bundle }) => {
    const sourceBundle = result.outputs[bundle];
    return sourceBundle ? { kind, sourceBundle } : undefined;
  }).find((found) => found !== undefined);
  const log = result.log?.uri ?? "none";
  const outcome: AuthoringTurnResult =
    handOff && result.session
      ? {
          kind: handOff.kind,
          task: {
            candidateId: candidate.candidateId,
            // A revision keeps its task's name; a new task is named after its candidate.
            taskId: input.draft?.taskId ?? candidate.candidateId,
            sourceBundle: handOff.sourceBundle,
          },
          session: result.session,
        }
      : {
          kind: "rejected",
          candidateId: candidate.candidateId,
          reason: `authoring round ${round}: the agent submitted nothing${result.finalMessage ? `; agent said: ${result.finalMessage.slice(0, 1_000)}` : ""}; log: ${log}`,
        };
  const body = Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`);
  await store.put(`${turnPrefix(input)}/result.json`, body, "application/json");
  if (outcome.kind !== "verify") {
    await store.put(
      authoringRoundResultKey(run.runId, candidate.candidateId, round),
      body,
      "application/json",
    );
  }
  return outcome;
}

/**
 * Round 1 gets the full brief, and a revision also the person's feedback on the restored task;
 * later rounds resume the session with the report and any feedback.
 */
export function authoringPrompt(
  candidate: Candidate,
  round: number,
  report?: string,
  feedback?: string,
  maintainerFeedback?: string,
): string {
  // A workspace scenario's author writes the files; a PR's or repository scenario's clones them.
  const workspace = candidate.kind === "scenario" && !candidate.baseCommit;
  const howToWork = workspace
    ? "scenario-how-to-work"
    : candidate.kind === "scenario"
      ? "repository-scenario-how-to-work"
      : "how-to-work";
  const shared = {
    howToWork: renderPrompt(howToWork, {
      verifyBudget: AUTHOR_VERIFY_BUDGET,
      round,
      rounds: MAX_AUTHORING_ROUNDS,
    }),
    feedback: feedback ? renderPrompt("feedback", { feedback }) : "",
  };
  if (report) {
    return renderPrompt("revision", {
      ...shared,
      reason: feedback
        ? "The reviewer requested revisions. The report below describes your latest tested draft, not a failed check."
        : "Your previous submission did not pass verification. Read the report below and address its failures.",
      fresh: workspace
        ? "This is a fresh sandbox: /work/task holds your last submitted draft, workspace/ included."
        : "This is a fresh sandbox: the repository was re-cloned and /work/task holds your last submitted draft.",
      report: report.trim(),
    });
  }
  const limits = `${TASK_LIMITS.cpus} CPUs, ${TASK_LIMITS.memoryMb / 1024} GB of memory, ${TASK_LIMITS.storageMb / 1024} GB of storage, ${TASK_LIMITS.buildSeconds / 60} minutes to build each image, and ${TASK_LIMITS.testsSeconds / 60} minutes for the tests (fail-to-pass runs twice)`;
  const maintainer = maintainerFeedback
    ? renderPrompt("maintainer-feedback", { feedback: maintainerFeedback.trim() })
    : "";
  if (candidate.kind === "scenario" && candidate.baseCommit) {
    return renderPrompt("repository-scenario-authoring", {
      ...shared,
      title: candidate.title,
      difficulty: candidate.difficulty,
      baseCommit: candidate.baseCommit,
      request: candidate.request,
      attachments: candidate.attachments
        ? "The requester attached files; they are in /work/attachments. Use them as context for the change, such as a design, a log, or an example; don't commit them to the repository unless the scenario asks for that."
        : "The requester attached no files.",
      limits,
      maintainer,
    });
  }
  if (candidate.kind === "scenario") {
    return renderPrompt("scenario-authoring", {
      ...shared,
      title: candidate.title,
      difficulty: candidate.difficulty,
      request: candidate.request,
      attachments: candidate.attachments
        ? "The requester attached files; they are in /work/attachments. They are real examples of what the agent faced: build the workspace from them where the scenario calls for them."
        : "The requester attached no files.",
      limits,
      maintainer,
    });
  }
  const tiers = Object.entries(difficultyThresholds)
    .map(
      ([tier, t]) =>
        `${tier}: ≥${t.changedLines} changed implementation lines across ≥${t.implementationFiles} file${t.implementationFiles === 1 ? "" : "s"}`,
    )
    .join("; ");
  return renderPrompt("authoring", {
    ...shared,
    sourceUrl: candidate.sourceUrl,
    sourcePr: candidate.sourcePr,
    baseCommit: candidate.baseCommit,
    completedCommit: candidate.completedCommit,
    difficulty: candidate.difficulty,
    request: candidate.request,
    tiers,
    limits,
    maintainer,
  });
}

/** The next turn's message after a `verify`: the report and what to do with it. */
export function verifyResultPrompt(report: VerifyReport | undefined, verifiesLeft: number): string {
  if (!report) throw new Error("a turn after verify needs the verify report");
  const next = report.green
    ? "Call submit_task now."
    : verifiesLeft > 0
      ? "Fix what the report names and verify again."
      : "No verify calls remain: call submit_task with your best task, or explain why it can't be made fair.";
  return renderPrompt("verify-result", {
    report: renderVerifyReport(report).trim(),
    green: String(report.green),
    verifiesLeft,
    next,
  });
}
