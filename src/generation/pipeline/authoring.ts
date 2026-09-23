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
import { verifierRuntimeFiles } from "../task/runtime-assets.js";
import { finishAgent, startAgent } from "./agent.js";
import { artifactFile, readAsset } from "./helpers.js";
import { renderPrompt } from "./prompts.js";
import type { SandboxCallback } from "./sandbox-job.js";
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
  readonly verifiesLeft: number;
}

const SUBMISSION = "/work/submission";
const VERIFY_REQUEST = "/work/verify";
const DRAFT = "/work/draft.tar.gz";
// Unpacks the draft and splits its prompt back out into instruction.md, as the agent wrote it.
export const RESTORE_DRAFT = `mkdir -p /work/task
tar -xzf ${DRAFT} -C /work/task
node -e '
const fs = require("fs");
const path = "/work/task/definition.json";
const { prompt, ...definition } = JSON.parse(fs.readFileSync(path, "utf8"));
fs.writeFileSync(path, JSON.stringify(definition, null, 2) + "\\n");
fs.writeFileSync("/work/task/instruction.md", prompt + "\\n");
'`;

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
  { kind: "submitted", directory: SUBMISSION },
  { kind: "verify", directory: VERIFY_REQUEST },
] as const;
const handOffFiles = (directory: string) => [
  `${directory}/definition.json`,
  `${directory}/source-task.tar.gz`,
];

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
  const [provenance, extension, checker, report, draft] = await Promise.all([
    store.get(candidate.provenance),
    readAsset("dist/extension-authoring.bundle.js"),
    readAsset("dist/sandbox-check.bundle.js"),
    input.report ? store.get(input.report) : undefined,
    input.draft ? artifactFile(store, input.draft.sourceBundle, DRAFT) : undefined,
  ]);
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
    workspace: { kind: "clone", commit: candidate.baseCommit },
    ...(draft ? { setup: RESTORE_DRAFT } : {}),
    extension: "/work/authoring.js",
    tools: "read,bash,grep,find,ls,verify,submit_task",
    prompt:
      turn === 1
        ? authoringPrompt(
            candidate,
            round,
            verifyReport && renderVerifyReport(verifyReport),
            input.feedback,
          )
        : verifyResultPrompt(verifyReport, input.verifiesLeft),
    files: [
      ...Object.entries(verifierRuntimeFiles()).map(([path, contents]) => ({
        path: `/work/${path}`,
        contents,
      })),
      { path: "/work/authoring.js", contents: extension },
      { path: "/work/sandbox-check.js", contents: checker },
      { path: "/work/provenance.json", contents: provenance },
      ...(draft ? [draft] : []),
    ],
    outputs: HAND_OFFS.flatMap(({ directory }) => handOffFiles(directory)),
    inline: HAND_OFFS.map(({ directory }) => `${directory}/definition.json`),
    delivers: HAND_OFFS.map(({ directory }) => handOffFiles(directory)),
    environment: {
      SELFBENCH_DELIVERABLE: "/work/task",
      SELFBENCH_SUBMISSION: SUBMISSION,
      SELFBENCH_VERIFY_REQUEST: VERIFY_REQUEST,
      SELFBENCH_CHECK_PROGRAM: "/work/sandbox-check.js",
      SELFBENCH_HARBOR_ENVIRONMENT: run.version.harborEnvironment,
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
  const handOff = HAND_OFFS.map(({ kind, directory }) => {
    const [definition, sourceBundle] = handOffFiles(directory).map((path) => result.outputs[path]);
    const parsed = result.inline[`${directory}/definition.json`] as
      | { taskId?: unknown }
      | undefined;
    return definition && sourceBundle ? { kind, definition, sourceBundle, parsed } : undefined;
  }).find((found) => found !== undefined);
  const log = result.log?.uri ?? "none";
  const outcome: AuthoringTurnResult =
    handOff && result.session
      ? {
          kind: handOff.kind,
          task: {
            candidateId: candidate.candidateId,
            taskId:
              typeof handOff.parsed?.taskId === "string" && handOff.parsed.taskId
                ? handOff.parsed.taskId
                : candidate.candidateId,
            definition: handOff.definition,
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

/** Round 1 gets the full brief; later rounds resume the session with the report and any feedback. */
export function authoringPrompt(
  candidate: Candidate,
  round: number,
  report?: string,
  feedback?: string,
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
      rounds: MAX_AUTHORING_ROUNDS,
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
