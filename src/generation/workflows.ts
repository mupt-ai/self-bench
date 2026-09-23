import {
  type ActivityOptions,
  defineQuery,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import {
  type ArtifactRef,
  type AuthoredTask,
  type Candidate,
  type CandidateWorkflowInput,
  type CandidateWorkflowResult,
  type DiscoveryResult,
  MAX_AUTHORING_ROUNDS,
  type RunStatus,
  type TaskProgress,
} from "../contracts/index.js";
import { harborTaskQueue } from "../temporal/task-queues.js";
import type { DiscoveryShardInput, SelfBenchActivities } from "./activities.js";
import { verifyReportSummary } from "./verify-report.js";

export const statusQuery = defineQuery<RunStatus>("status");
export const candidateStatusQuery = defineQuery<TaskProgress>("candidateStatus");

const retry = { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes" };
const candidateOptions: ActivityOptions = {
  startToCloseTimeout: "7 hours",
  heartbeatTimeout: "10 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: { ...retry, maximumAttempts: 4 },
};
const agents =
  proxyActivities<Pick<SelfBenchActivities, "runAuthoringRound" | "runReviewRound">>(
    candidateOptions,
  );
const discovery = proxyActivities<Pick<SelfBenchActivities, "discoverCandidateShard">>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "10 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: { ...retry, maximumInterval: "1 minute", maximumAttempts: 3 },
});

/** The workflow's activities; Harbor verification runs on the memory-sized sibling queue. */
export const workflowActivities: SelfBenchActivities = {
  discoverCandidateShard: (input) => discovery.discoverCandidateShard(input),
  runAuthoringRound: (input) => agents.runAuthoringRound(input),
  runReviewRound: (input) => agents.runReviewRound(input),
  compileAndVerify: (input) =>
    proxyActivities<Pick<SelfBenchActivities, "compileAndVerify">>({
      ...candidateOptions,
      taskQueue: harborTaskQueue(workflowInfo().taskQueue),
    }).compileAndVerify(input),
};

/** Independent discovery unit. Fetching PR metadata and dispatch happen in the API. */
export async function selfBenchDiscoveryShardWorkflow(
  input: DiscoveryShardInput,
): Promise<DiscoveryResult> {
  return workflowActivities.discoverCandidateShard(input);
}

/** Authors, verifies, and reviews one candidate. */
export async function selfBenchAuthorWorkflow(
  input: CandidateWorkflowInput,
): Promise<CandidateWorkflowResult> {
  let current = initialProgress(input.candidate);
  setHandler(candidateStatusQuery, () => current);
  return executeCandidate(input, workflowActivities, (progress) => {
    current = progress;
  });
}

/** Cancellation tombstone: reserves a never-started dispatch ID without any paid activities. */
export async function selfBenchCancelledDispatchWorkflow(): Promise<void> {}

export function initialProgress(candidate: Candidate): TaskProgress {
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
 * Up to MAX_AUTHORING_ROUNDS rounds: the author submits, the worker verifies the submission,
 * and a green task goes to a fresh reviewer who accepts, rejects, or sends suggestions back.
 * Activities that exhaust their retries mark the candidate infrastructure_failed.
 */
export async function executeCandidate(
  input: CandidateWorkflowInput,
  activities: SelfBenchActivities,
  report: (progress: TaskProgress) => void,
): Promise<CandidateWorkflowResult> {
  const { run, candidate } = input;
  const progress = initialProgress(candidate);
  const update = (patch: Partial<TaskProgress>): TaskProgress => {
    Object.assign(progress, patch);
    const snapshot = { ...progress };
    report(snapshot);
    return snapshot;
  };
  const finish = (status: "rejected" | "infrastructure_failed", reason: string) => ({
    progress: update({ status, reason }),
  });
  update({});
  let session: ArtifactRef | undefined;
  let lastReport: ArtifactRef | undefined;
  let feedback: string | undefined;
  let lastSummary = "no verification report";
  let reviews = 0;
  try {
    for (let round = 1; round <= MAX_AUTHORING_ROUNDS; round += 1) {
      update({ status: "authoring", stage: "authoring", round });
      const authored = await activities.runAuthoringRound({
        run,
        candidate,
        round,
        ...(session ? { session } : {}),
        ...(lastReport ? { report: lastReport } : {}),
        ...(feedback ? { feedback } : {}),
      });
      if (authored.kind === "rejected") return finish("rejected", authored.reason);
      session = authored.session;
      update({ status: "verifying", taskId: authored.task.taskId });
      const verified = await activities.compileAndVerify({
        run,
        candidate,
        task: authored.task,
        stage: "authoring",
        round,
      });
      lastReport = verified.reportRef;
      lastSummary = verifyReportSummary(verified.report);
      feedback = undefined;
      if (!verified.report.green || !verified.task) continue;
      const task: AuthoredTask = verified.task;
      reviews += 1;
      update({ status: "reviewing", stage: "review", round: reviews });
      const verdict = await activities.runReviewRound({
        run,
        candidate,
        task,
        report: verified.reportRef,
        round: reviews,
      });
      if (verdict.kind === "accepted") {
        return { progress: update({ status: "accepted" }), task, report: verified.reportRef };
      }
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
function rootMessage(error: unknown): string {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  return current instanceof Error ? current.message : String(current);
}
