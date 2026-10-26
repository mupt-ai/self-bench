import {
  type ActivityOptions,
  CancellationScope,
  isCancellation,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import {
  type ArtifactRef,
  AUTHOR_VERIFY_BUDGET,
  type AuthoredTask,
  type AuthoredTaskDraft,
  type Candidate,
  type CandidateWorkflowInput,
  type CandidateWorkflowResult,
  type DiscoveryResult,
  MAX_AUTHORING_ROUNDS,
  type TaskProgress,
} from "../../contracts/index.js";
import { whenSandboxFree } from "../../temporal/sandbox-capacity.js";
import type { TaskActivities } from "../tasks/activities.js";
import type { DiscoveryShardInput, SelfBenchActivities, WorkerActivities } from "./activities.js";
import { verifyReportSummary } from "./verify-report.js";

/** How long a candidate may take, waits for sandbox capacity included, before it gives up. */
const CANDIDATE_DEADLINE_MS = 14 * 24 * 60 * 60_000;

const retry = { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes" };
// A started sandbox heartbeats through the callback API every minute until it reports back.
const started = (startToCloseTimeout: string, maximumAttempts: number): ActivityOptions => ({
  startToCloseTimeout,
  heartbeatTimeout: "5 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: { ...retry, maximumAttempts },
});
const finishing: ActivityOptions = {
  startToCloseTimeout: "15 minutes",
  retry: { ...retry, maximumAttempts: 5 },
};
const agents = proxyActivities<Pick<WorkerActivities, "startAuthoringTurn" | "startReviewRound">>(
  started("5 hours", 4),
);
const compile = proxyActivities<Pick<WorkerActivities, "compileTask">>(started("1 hour", 4));
const discovery = proxyActivities<Pick<WorkerActivities, "startDiscoveryShard">>(
  started("1 hour", 3),
);
const finish =
  proxyActivities<
    Pick<
      WorkerActivities,
      "finishDiscoveryShard" | "finishAuthoringTurn" | "finishReviewRound" | "finishCompile"
    >
  >(finishing);
const harbor = () =>
  proxyActivities<Pick<WorkerActivities, "verifyCompiled">>({
    startToCloseTimeout: "7 hours",
    heartbeatTimeout: "10 minutes",
    cancellationType: "WAIT_CANCELLATION_COMPLETED",
    retry: { ...retry, maximumAttempts: 4 },
    taskQueue: `${workflowInfo().taskQueue}-harbor`,
  });

// A row write waits out a database outage rather than leave its task unsettled.
const rows = proxyActivities<TaskActivities>({ startToCloseTimeout: "1 minute", retry });

// Compaction streams each green attempt's full bundle once to check it before deleting it.
const compaction = () =>
  proxyActivities<Pick<WorkerActivities, "compactCandidateBundles">>({
    startToCloseTimeout: "2 hours",
    heartbeatTimeout: "5 minutes",
    retry: { ...retry, maximumAttempts: 3 },
  });

/**
 * The workflow's steps. Each starts a sandbox that reports back through the callback API, then
 * reads what it reported; Harbor checks a compiled task on the memory-sized sibling queue.
 */
const workflowActivities: SelfBenchActivities = {
  discoverCandidateShard: async (input) =>
    await finish.finishDiscoveryShard({
      ...input,
      outcome: await whenSandboxFree(() => discovery.startDiscoveryShard(input)),
    }),
  runAuthoringTurn: async (input) =>
    await finish.finishAuthoringTurn({
      ...input,
      outcome: await whenSandboxFree(() => agents.startAuthoringTurn(input)),
    }),
  runReviewRound: async (input) =>
    await finish.finishReviewRound({
      ...input,
      outcome: await whenSandboxFree(() => agents.startReviewRound(input)),
    }),
  compileAndVerify: async (input) => {
    const compiled = await whenSandboxFree(() => compile.compileTask(input));
    const finished = await finish.finishCompile({ ...input, compiled });
    return await whenSandboxFree(() => harbor().verifyCompiled({ ...input, compiled: finished }));
  },
};

/** One discovery shard of a batch; the batch workflow fetched its merged PRs. */
export async function selfBenchDiscoveryShardWorkflow(
  input: DiscoveryShardInput,
): Promise<DiscoveryResult> {
  return workflowActivities.discoverCandidateShard(input);
}

/**
 * Authors, verifies, and reviews one candidate, and owns its task row: each stage change is
 * recorded on it, and the workflow settles it however it ends, cancelled or out of time included.
 */
export async function selfBenchAuthorWorkflow(
  input: CandidateWorkflowInput,
): Promise<CandidateWorkflowResult> {
  const row = { runId: input.run.runId, candidateId: input.candidate.candidateId };
  let last = initialProgress(input.candidate);
  let result: CandidateWorkflowResult;
  try {
    result = await CancellationScope.withTimeout(CANDIDATE_DEADLINE_MS, () =>
      executeCandidate(input, workflowActivities, async (progress) => {
        last = progress;
        await rows.recordTaskProgress({ ...row, progress });
      }),
    );
  } catch (error) {
    if (!isCancellation(error)) throw error;
    const cancelled = CancellationScope.current().consideredCancelled;
    result = {
      progress: {
        ...last,
        status: "infrastructure_failed",
        reason: cancelled ? "Generation cancelled." : "Generation ran out of time (14 days).",
      },
    };
    // A cancelled candidate still records where it stopped, then reports its cancellation.
    await CancellationScope.nonCancellable(() =>
      rows.settleTask({ ...row, result, ...(cancelled ? { cancelled } : {}) }),
    );
    if (cancelled) throw error;
    await compact(input, result);
    return result;
  }
  // A finished verdict reaches the row even if a cancel lands meanwhile.
  await CancellationScope.nonCancellable(() => rows.settleTask({ ...row, result }));
  await compact(input, result);
  return result;
}

/** Drops the candidate's superseded compile attempts. Only storage is at stake, so never fails. */
async function compact(input: CandidateWorkflowInput, result: CandidateWorkflowResult) {
  const kept = result.task ? artifactKey(result.task.bundle.uri) : undefined;
  // A task bundle outside the run's artifacts is never expected; compaction then keeps everything.
  if (result.task && !kept) return;
  await compaction()
    .compactCandidateBundles({
      runId: input.run.runId,
      candidateId: input.candidate.candidateId,
      kept: kept ? [kept] : [],
    })
    .catch((error: unknown) => {
      if (isCancellation(error)) throw error;
    });
}

/** The store key in an artifact URI (`gs://bucket/<prefix>/runs/...` or `file://.../runs/...`). */
function artifactKey(uri: string): string | undefined {
  const index = uri.indexOf("/runs/");
  return index < 0 ? undefined : uri.slice(index + 1);
}

function initialProgress(candidate: Candidate): TaskProgress {
  return {
    candidateId: candidate.candidateId,
    taskId: candidate.candidateId,
    difficulty: candidate.difficulty,
    status: "authoring",
    stage: "authoring",
    round: 1,
  };
}

/**
 * Up to MAX_AUTHORING_ROUNDS rounds. Within a round the author works in turns: each `verify` ends
 * a turn, the worker checks the draft, and the next turn resumes the session with the report. A
 * submission is verified again, and a green task goes to a fresh reviewer who accepts, rejects, or
 * sends suggestions back. Activities that exhaust their retries mark the candidate
 * infrastructure_failed.
 */
export async function executeCandidate(
  input: CandidateWorkflowInput,
  activities: SelfBenchActivities,
  report: (progress: TaskProgress) => Promise<void>,
): Promise<CandidateWorkflowResult> {
  const { run, candidate } = input;
  const progress = initialProgress(candidate);
  // Each change of where the candidate is reaches its row; the verdict is the caller's to settle.
  let reported = "";
  const update = async (patch: Partial<TaskProgress>): Promise<void> => {
    Object.assign(progress, patch);
    const key = JSON.stringify([progress.status, progress.round, progress.taskId]);
    if (key === reported) return;
    reported = key;
    await report({ ...progress });
  };
  const finish = (status: "rejected" | "infrastructure_failed", reason: string) => ({
    progress: { ...progress, status, reason },
  });
  // A revision restores the task it revises and hands the person's feedback to the first turn.
  const maintainerFeedback = input.revision?.feedback;
  let session: ArtifactRef | undefined;
  let draft: AuthoredTaskDraft | undefined = input.revision?.draft;
  let lastReport: ArtifactRef | undefined;
  let feedback: string | undefined;
  let lastSummary = "no verification report";
  let reviews = 0;
  try {
    for (let round = 1; round <= MAX_AUTHORING_ROUNDS; round += 1) {
      await update({ status: "authoring", stage: "authoring", round });
      let turnReport = lastReport;
      let submitted: AuthoredTaskDraft | undefined;
      for (let turn = 1; ; turn += 1) {
        const authored = await activities.runAuthoringTurn({
          run,
          candidate,
          round,
          turn,
          verifiesLeft: AUTHOR_VERIFY_BUDGET - (turn - 1),
          ...(session ? { session } : {}),
          ...(draft ? { draft } : {}),
          ...(turnReport ? { report: turnReport } : {}),
          ...(feedback && turn === 1 ? { feedback } : {}),
          ...(maintainerFeedback && round === 1 && turn === 1 ? { maintainerFeedback } : {}),
        });
        if (authored.kind === "rejected") return finish("rejected", authored.reason);
        session = authored.session;
        draft = authored.task;
        if (authored.kind === "submitted") {
          submitted = authored.task;
          break;
        }
        // The verify tool refuses past the budget; never run checks the budget doesn't cover.
        if (turn > AUTHOR_VERIFY_BUDGET) break;
        await update({ status: "verifying", taskId: authored.task.taskId });
        const checked = await activities.compileAndVerify({
          run,
          candidate,
          task: authored.task,
          stage: "authoring",
          round,
          turn,
        });
        turnReport = checked.reportRef;
        await update({ status: "authoring" });
      }
      if (!submitted) {
        return finish("rejected", `authoring round ${round}: the agent never submitted a task`);
      }
      await update({ status: "verifying", taskId: submitted.taskId });
      const verified = await activities.compileAndVerify({
        run,
        candidate,
        task: submitted,
        stage: "authoring",
        round,
      });
      lastReport = verified.reportRef;
      lastSummary = verifyReportSummary(verified.report);
      feedback = undefined;
      if (!verified.report.green || !verified.task) continue;
      const task: AuthoredTask = verified.task;
      reviews += 1;
      await update({ status: "reviewing", stage: "review", round: reviews });
      const verdict = await activities.runReviewRound({
        run,
        candidate,
        task,
        report: verified.reportRef,
        round: reviews,
        ...(maintainerFeedback ? { maintainerFeedback } : {}),
      });
      if (verdict.kind === "accepted")
        return { progress: { ...progress, status: "accepted" }, task, report: verified.reportRef };
      if (verdict.kind === "rejected") return finish("rejected", verdict.reason);
      feedback = `${verdict.summary}\n\n${verdict.suggestions}`;
      lastSummary = `reviewer requested changes: ${feedback}`;
    }
    return finish("rejected", `authoring exhausted ${MAX_AUTHORING_ROUNDS} rounds; ${lastSummary}`);
  } catch (error) {
    if (isCancellation(error)) throw error;
    return finish("infrastructure_failed", rootMessage(error));
  }
}

/** The innermost cause's message: Temporal wraps activity failures several levels deep. */
export function rootMessage(error: unknown): string {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  return current instanceof Error ? current.message : String(current);
}
