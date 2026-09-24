import {
  type ActivityOptions,
  CancellationScope,
  defineQuery,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
  sleep,
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
  type RunRequest,
  type TaskProgress,
} from "../../contracts/index.js";
import { harborTaskQueue } from "../../temporal/task-queues.js";
import type { DiscoveryShardInput, SelfBenchActivities, WorkerActivities } from "./activities.js";
import { verifyReportSummary } from "./verify-report.js";
import type { WorkflowSlotActivities } from "./workflow-slots.js";

export const candidateStatusQuery = defineQuery<TaskProgress>("candidateStatus");

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
    taskQueue: harborTaskQueue(workflowInfo().taskQueue),
  });

/**
 * The workflow's steps. Each starts a sandbox that reports back through the callback API, then
 * reads what it reported; Harbor checks a compiled task on the memory-sized sibling queue.
 */
export const workflowActivities: SelfBenchActivities = {
  discoverCandidateShard: async (input) =>
    await finish.finishDiscoveryShard({
      ...input,
      outcome: await discovery.startDiscoveryShard(input),
    }),
  runAuthoringTurn: async (input) =>
    await finish.finishAuthoringTurn({ ...input, outcome: await agents.startAuthoringTurn(input) }),
  runReviewRound: async (input) =>
    await finish.finishReviewRound({ ...input, outcome: await agents.startReviewRound(input) }),
  compileAndVerify: async (input) => {
    const compiled = await compile.compileTask(input);
    return await harbor().verifyCompiled({
      ...input,
      compiled: await finish.finishCompile({ ...input, compiled }),
    });
  },
};

const slots = proxyActivities<WorkflowSlotActivities>({
  startToCloseTimeout: "1 minute",
  retry: { ...retry, maximumAttempts: 10 },
});

/**
 * Runs a managed workflow only once it holds one of the platform's workflow slots, waiting its
 * turn on durable timers. A workflow that is cancelled or fails may leave its sandbox running,
 * so its slot drains instead of freeing at once. Workflows started earlier skip this.
 */
async function withWorkflowSlot<T>(run: RunRequest, action: () => Promise<T>): Promise<T> {
  const generation = run.generation;
  if (generation?.settings.sandbox !== "managed" || !patched("workflow-slots")) return action();
  const { workflowId, runId } = workflowInfo();
  const id = `${workflowId}/${runId}`;
  const orgId = String(generation.orgId ?? generation.ownerId);
  let finished = false;
  try {
    for (let wait = 5; !(await slots.acquireWorkflowSlot({ id, orgId })); ) {
      await sleep(`${wait} seconds`);
      wait = Math.min(wait * 2, 30);
    }
    const result = await action();
    finished = true;
    return result;
  } finally {
    await CancellationScope.nonCancellable(() =>
      slots.releaseWorkflowSlot({ id, drain: !finished }),
    );
  }
}

/** Independent discovery unit. Fetching PR metadata and dispatch happen in the API. */
export async function selfBenchDiscoveryShardWorkflow(
  input: DiscoveryShardInput,
): Promise<DiscoveryResult> {
  return withWorkflowSlot(input.run, () => workflowActivities.discoverCandidateShard(input));
}

/** Authors, verifies, and reviews one candidate. */
export async function selfBenchAuthorWorkflow(
  input: CandidateWorkflowInput,
): Promise<CandidateWorkflowResult> {
  let current = initialProgress(input.candidate);
  setHandler(candidateStatusQuery, () => current);
  return withWorkflowSlot(input.run, () =>
    executeCandidate(input, workflowActivities, (progress) => {
      current = progress;
    }),
  );
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
 * Up to MAX_AUTHORING_ROUNDS rounds. Within a round the author works in turns: each `verify` ends
 * a turn, the worker checks the draft, and the next turn resumes the session with the report. A
 * submission is verified again, and a green task goes to a fresh reviewer who accepts, rejects, or
 * sends suggestions back. Activities that exhaust their retries mark the candidate
 * infrastructure_failed.
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
  let draft: AuthoredTaskDraft | undefined;
  let lastReport: ArtifactRef | undefined;
  let feedback: string | undefined;
  let lastSummary = "no verification report";
  let reviews = 0;
  try {
    for (let round = 1; round <= MAX_AUTHORING_ROUNDS; round += 1) {
      update({ status: "authoring", stage: "authoring", round });
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
        update({ status: "verifying", taskId: authored.task.taskId });
        const checked = await activities.compileAndVerify({
          run,
          candidate,
          task: authored.task,
          stage: "authoring",
          round,
          turn,
        });
        turnReport = checked.reportRef;
        update({ status: "authoring" });
      }
      if (!submitted) {
        return finish("rejected", `authoring round ${round}: the agent never submitted a task`);
      }
      update({ status: "verifying", taskId: submitted.taskId });
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
