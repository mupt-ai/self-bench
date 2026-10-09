import {
  ActivityCancellationType,
  CancellationScope,
  ChildWorkflowCancellationType,
  executeChild,
  isCancellation,
  ParentClosePolicy,
  patched,
  proxyActivities,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";
import { trialTimeouts } from "../contracts/agent-limit.js";
import { MAX_PENDING_TRIAL_WORKFLOWS } from "../contracts/config/execution-limits.js";
import { whenSandboxFree } from "../temporal/sandbox-capacity.js";
import type { EvaluationActivities } from "./activities.js";
import { preparesTaskImages, trialInput } from "./trial-input.js";
import type { EvaluationInput } from "./types.js";

// A RepeatSpendError is final: retrying it cannot succeed and must not try to.
const REFUSED = ["RepeatSpendError"];
// One trial is one `harbor run` (trialTimeouts) plus its bundle and artifact transfers. A retry
// reaches Harbor only if no earlier attempt started the solver: one that never claimed the trial,
// returned the claim when its setup failed or its worker began stopping, or was lost with its
// worker before the solver started (executeTrial). Once a solver has started, a retry refuses with
// RepeatSpendError. The last attempt records its own setup failure on the trial.
const trial = (input: EvaluationInput) =>
  proxyActivities<EvaluationActivities>({
    startToCloseTimeout: trialTimeouts(input.agentMinutes).activityMs,
    heartbeatTimeout: "2 minutes",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 3, nonRetryableErrorTypes: REFUSED },
    taskQueue: `${workflowInfo().taskQueue}-harbor`,
  });
// Building a large task's two images from cold takes minutes; retrying once covers a lost worker.
const prepare = () =>
  proxyActivities<EvaluationActivities>({
    startToCloseTimeout: "90 minutes",
    heartbeatTimeout: "2 minutes",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 2 },
    taskQueue: `${workflowInfo().taskQueue}-harbor`,
  });
const records = proxyActivities<EvaluationActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, nonRetryableErrorTypes: REFUSED },
});
// One Pi call, which gives up after five minutes, and the write of what it said.
const explaining = proxyActivities<EvaluationActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 2 },
});

/**
 * Runs each trial as its own child workflow, `<evaluation workflow ID>/trial/<index>`, all started
 * at once, so a trial's history stands alone in Temporal and the Harbor queue sees the whole
 * evaluation; under a sandbox limit (maxTrials), each starts as another ends. Cancelling the
 * evaluation cancels every trial workflow and waits for each to record where it stopped; closing
 * it any other way terminates them. A task's trials start once its images are built
 * (taskImagesReady).
 */
export async function selfBenchEvaluationRunWorkflow(input: EvaluationInput): Promise<void> {
  const { workflowId } = workflowInfo();
  // Evaluations started before images were prepared replay without it.
  const ready = patched("prepare-task-images")
    ? taskImagesReady(input, {
        prepareTaskImages: (trialInput) =>
          whenSandboxFree(() => prepare().prepareTaskImages(trialInput)),
      })
    : async () => undefined;
  try {
    await runEvaluationTrials(
      input,
      records,
      async (input, index) => {
        await ready(index);
        await executeChild(selfBenchSolverTrialWorkflow, {
          workflowId: `${workflowId}/trial/${index}`,
          args: [trialInput(input, index), index],
          cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
          parentClosePolicy: ParentClosePolicy.TERMINATE,
        });
      },
      Math.min(MAX_PENDING_TRIAL_WORKFLOWS, input.maxTrials ?? Number.POSITIVE_INFINITY),
    );
  } catch {
    await CancellationScope.nonCancellable(() => records.failSolverEvaluation(input));
  }
}

/**
 * Waits, per trial, for its task's images: the first trial of each task builds them once
 * (prepareTaskImages) and the task's other trials wait on that build. A failed build only means
 * the trials build as they did before, so it never fails a trial.
 */
export function taskImagesReady(
  input: EvaluationInput,
  harbor: Pick<EvaluationActivities, "prepareTaskImages">,
): (index: number) => Promise<void> {
  if (!preparesTaskImages(input.sandbox)) return async () => undefined;
  const builds = new Map<number, Promise<void>>();
  return (index) => {
    const task = Math.floor(index / input.harnesses.length);
    let build = builds.get(task);
    if (!build) {
      build = harbor.prepareTaskImages(trialInput(input, index)).then(
        () => undefined,
        (error) => {
          if (isCancellation(error)) throw error;
        },
      );
      builds.set(task, build);
    }
    return build;
  };
}

/**
 * One trial of an evaluation: its Harbor activity, and its failure when it recorded none. In an
 * evaluation that explains failures, the trial then starts `<trial workflow ID>/explain` and ends
 * without waiting for it, so the explanation never holds the evaluation's place for another trial.
 * However the activity ended, the explanation finds whatever failure material the trial kept.
 */
export async function selfBenchSolverTrialWorkflow(
  input: EvaluationInput,
  index: number,
): Promise<void> {
  await runTrial(
    input,
    index,
    {
      runSolverTrial: (trialInput, trialIndex) =>
        whenSandboxFree(() => trial(trialInput).runSolverTrial(trialInput, trialIndex)),
    },
    records,
  );
  if (input.explainFailures && patched("explain-failed-trials"))
    await startChild(selfBenchFailedTrialWorkflow, {
      workflowId: `${workflowInfo().workflowId}/explain`,
      args: [input, index],
      parentClosePolicy: ParentClosePolicy.ABANDON,
    });
}

/** Explains why a trial failed its tests (failure-summary.ts), after the trial has ended. */
export async function selfBenchFailedTrialWorkflow(
  input: EvaluationInput,
  index: number,
): Promise<void> {
  await explaining.explainSolverTrial(input, index);
}

/**
 * Runs one trial. A trial activity that fails without recording an outcome (a lost worker, a
 * timeout) fails that trial alone; a cancellation propagates once the activity has stopped.
 */
export async function runTrial(
  input: EvaluationInput,
  index: number,
  harbor: Pick<EvaluationActivities, "runSolverTrial">,
  records: Pick<EvaluationActivities, "failSolverTrial">,
): Promise<void> {
  try {
    await harbor.runSolverTrial(input, index);
  } catch (error) {
    if (isCancellation(error)) throw error;
    await records.failSolverTrial(input, index);
  }
}

/**
 * Starts the evaluation, runs its trials with at most `concurrency` in flight, then records the
 * outcome. A trial that fails without recording one fails only that trial; a cancellation stops
 * the rest once every running trial has recorded where it ended.
 */
export async function runEvaluationTrials(
  input: EvaluationInput,
  records: Pick<
    EvaluationActivities,
    "startSolverEvaluation" | "failSolverTrial" | "finishSolverEvaluation"
  >,
  solve: (input: EvaluationInput, index: number) => Promise<void>,
  concurrency: number,
): Promise<void> {
  const trials = await records.startSolverEvaluation(input);
  let next = 0;
  const lane = async () => {
    while (next < trials) {
      const index = next;
      next += 1;
      await runTrial(input, index, { runSolverTrial: solve }, records);
    }
  };
  const lanes = await Promise.allSettled(
    Array.from({ length: Math.min(trials, concurrency) }, lane),
  );
  const failure = lanes.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  await records.finishSolverEvaluation(input);
}
