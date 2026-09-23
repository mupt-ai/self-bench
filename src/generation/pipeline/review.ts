import { Context } from "@temporalio/activity";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import {
  type ArtifactRef,
  type AuthoredTask,
  type Candidate,
  type ReviewRoundResult,
  type RunRequest,
  taskDefinitionSchema,
  verifyReportSchema,
} from "../../contracts/index.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import type { SandboxJobOutcome } from "../../sandbox/jobs.js";
import { finishAgent, startAgent } from "./agent.js";
import { artifactFile, readAsset } from "./helpers.js";
import { renderPrompt } from "./prompts.js";
import type { SandboxCallback } from "./sandbox-job.js";
import { renderVerifyReport } from "./verify-report.js";

export interface ReviewRoundInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly task: AuthoredTask;
  readonly report: ArtifactRef;
  readonly round: number;
}

const VERDICT = "/work/verdict/verdict.json";
const verdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), reason: z.string().min(1) }),
  z.object({
    kind: z.literal("suggestions"),
    summary: z.string().min(1),
    suggestions: z.string().min(1),
  }),
  z.object({ kind: z.literal("rejected"), reason: z.string().min(1) }),
]);

export interface FinishReviewRoundInput extends ReviewRoundInput {
  readonly outcome: SandboxJobOutcome;
}

function roundPrefix({ run, candidate, round }: ReviewRoundInput): string {
  return `runs/${run.runId}/review/${candidate.candidateId}/round-${round}`;
}

/**
 * A fresh, read-only reviewer judges one green task: accept, suggest changes, or reject. The
 * sandbox reports back through the callback API; `finishReviewRound` reads the verdict. A
 * reviewer that crashed without a verdict fails in the sandbox, so Temporal retries it.
 */
export async function startReviewRound(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  callback: SandboxCallback,
  input: ReviewRoundInput,
): Promise<SandboxJobOutcome> {
  const { run, candidate, task, round } = input;
  const attempt = Context.current().info.attempt;
  const [reportBytes, definitionBytes, extension, program, bundle] = await Promise.all([
    store.get(input.report),
    store.get(task.definition),
    readAsset("dist/extension-reviewer.bundle.js"),
    readAsset("dist/sandbox-verifier.bundle.js"),
    artifactFile(store, task.bundle, "/work/task.tar.gz"),
  ]);
  const report = verifyReportSchema.parse(JSON.parse(Buffer.from(reportBytes).toString("utf8")));
  if (!report.green) throw new Error("review requires a green report");
  const definition = taskDefinitionSchema.parse(
    JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
  );
  return await startAgent({
    store,
    sandbox,
    callback,
    run,
    label: `verify-${candidate.candidateId}-r${round}`,
    prefix: `${roundPrefix(input)}/attempt-${attempt}`,
    record: { stage: "review", round, attempt },
    workspace: { kind: "task" },
    extension: "/work/reviewer.js",
    tools: "read,grep,find,ls,accept_task,submit_suggestions,reject_task",
    prompt: renderPrompt("review", {
      taskId: task.taskId,
      instruction: definition.prompt.trim(),
      report: renderVerifyReport(report).trim(),
    }),
    files: [
      bundle,
      { path: "/work/sandbox-verifier.js", contents: program },
      { path: "/work/reviewer.js", contents: extension },
    ],
    outputs: [VERDICT],
    inline: [VERDICT],
    delivers: [[VERDICT]],
    environment: { SELFBENCH_VERDICT_OUTPUT: "/work/verdict" },
    timeoutMs: 4 * 60 * 60 * 1000,
  });
}

/** Stops the reviewer's sandbox and turns its verdict into the round's result. */
export async function finishReviewRound(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: FinishReviewRoundInput,
): Promise<ReviewRoundResult> {
  const { candidate } = input;
  const result = await finishAgent(store, sandbox, input.outcome);
  const log = result.log?.uri ?? "none";
  const verdict = result.inline[VERDICT];
  let outcome: ReviewRoundResult;
  if (verdict !== undefined && result.session) {
    const parsed = verdictSchema.parse(verdict);
    outcome =
      parsed.kind === "rejected"
        ? {
            kind: "rejected",
            candidateId: candidate.candidateId,
            reason: `${parsed.reason}; log: ${log}`,
          }
        : { ...parsed, session: result.session };
  } else {
    outcome = {
      kind: "rejected",
      candidateId: candidate.candidateId,
      reason: `review agent declined the task${result.finalMessage ? `: ${result.finalMessage.slice(0, 1_000)}` : ""}; log: ${log}`,
    };
  }
  await store.put(
    `${roundPrefix(input)}/result.json`,
    Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`),
    "application/json",
  );
  return outcome;
}
