import {
  ActivityCancellationType,
  CancellationScope,
  ChildWorkflowCancellationType,
  executeChild,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import { MAX_PENDING_TRIAL_WORKFLOWS } from "../contracts/config/execution-limits.js";
import { harborTaskQueue } from "../temporal/task-queues.js";
import type { EvaluationActivities } from "./activities.js";
import { trialInput } from "./trial-input.js";
import type { EvaluationInput } from "./types.js";

// A RepeatSpendError is final: retrying it cannot succeed and must not try to.
const REFUSED = ["RepeatSpendError"];
// One trial is one `harbor run` (capped at 2 hours) plus its bundle and artifact transfers. A retry
// reaches Harbor only if the earlier attempt never claimed the trial (it landed on a worker without
// this activity, or failed before the claim saved); a claimed trial refuses with RepeatSpendError.
const trial = () =>
  proxyActivities<EvaluationActivities>({
    startToCloseTimeout: "150 minutes",
    heartbeatTimeout: "2 minutes",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 3, nonRetryableErrorTypes: REFUSED },
    taskQueue: harborTaskQueue(workflowInfo().taskQueue),
  });
const records = proxyActivities<EvaluationActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, nonRetryableErrorTypes: REFUSED },
});

/**
 * Runs each trial as its own child workflow, `<evaluation workflow ID>/trial/<index>`, all started
 * at once, so a trial's history stands alone in Temporal and the Harbor queue sees the whole
 * evaluation. Cancelling the evaluation cancels every trial workflow and waits for each to record
 * where it stopped; closing it any other way terminates them.
 */
export async function selfBenchEvaluationRunWorkflow(input: EvaluationInput): Promise<void> {
  const { workflowId } = workflowInfo();
  try {
    await runEvaluationTrials(
      input,
      records,
      (input, index) =>
        executeChild(selfBenchSolverTrialWorkflow, {
          workflowId: `${workflowId}/trial/${index}`,
          args: [trialInput(input, index), index],
          cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
          parentClosePolicy: ParentClosePolicy.TERMINATE,
        }),
      MAX_PENDING_TRIAL_WORKFLOWS,
    );
  } catch {
    await CancellationScope.nonCancellable(() => records.failSolverEvaluation(input));
  }
}

/** One trial of an evaluation: its Harbor activity, and its failure when it recorded none. */
export async function selfBenchSolverTrialWorkflow(
  input: EvaluationInput,
  index: number,
): Promise<void> {
  await runTrial(input, index, trial(), records);
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
