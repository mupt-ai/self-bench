import {
  ActivityCancellationType,
  CancellationScope,
  isCancellation,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import { harborTaskQueue } from "../temporal/task-queues.js";
import type { EvaluationActivities } from "./activities.js";
import type { EvaluationInput } from "./types.js";

/** Trials of one evaluation running at once: one Harbor worker pod's slots. */
const EVALUATION_TRIAL_CONCURRENCY = 10;

const solver = () =>
  proxyActivities<EvaluationActivities>({
    startToCloseTimeout: "72 hours",
    heartbeatTimeout: "2 minutes",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
    taskQueue: harborTaskQueue(workflowInfo().taskQueue),
  });
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
const finalizer = proxyActivities<EvaluationActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});
const records = proxyActivities<EvaluationActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, nonRetryableErrorTypes: REFUSED },
});

/**
 * Runs every trial in one Harbor activity, one after another. Replaced by
 * selfBenchParallelEvaluationWorkflow and kept unchanged so evaluations already running on it
 * replay; remove it (and executeSolverEvaluation) once none are left, at most 73 hours after
 * the new type starts being used.
 */
export async function selfBenchEvaluationWorkflow(input: EvaluationInput): Promise<void> {
  try {
    await solver().executeSolverEvaluation(input);
  } catch {
    await CancellationScope.nonCancellable(() => finalizer.failSolverEvaluation(input));
  }
}

/**
 * Runs each trial as its own Harbor activity, up to EVALUATION_TRIAL_CONCURRENCY at once, so the
 * Harbor queue's backlog reflects the evaluation's size and its workers scale out to it.
 */
export async function selfBenchParallelEvaluationWorkflow(input: EvaluationInput): Promise<void> {
  try {
    await runEvaluationTrials(input, records, trial(), EVALUATION_TRIAL_CONCURRENCY);
  } catch {
    await CancellationScope.nonCancellable(() => records.failSolverEvaluation(input));
  }
}

/**
 * Starts the evaluation, runs its trials with at most `concurrency` in flight, then records the
 * outcome. A trial activity that fails without recording one (a lost worker, a timeout) fails only
 * that trial; a cancellation stops the rest once every running trial has recorded where it ended.
 */
export async function runEvaluationTrials(
  input: EvaluationInput,
  records: Pick<
    EvaluationActivities,
    "startSolverEvaluation" | "failSolverTrial" | "finishSolverEvaluation"
  >,
  harbor: Pick<EvaluationActivities, "runSolverTrial">,
  concurrency: number,
): Promise<void> {
  const trials = await records.startSolverEvaluation(input);
  let next = 0;
  const lane = async () => {
    while (next < trials) {
      const index = next;
      next += 1;
      try {
        await harbor.runSolverTrial(input, index);
      } catch (error) {
        if (isCancellation(error)) throw error;
        await records.failSolverTrial(input, index);
      }
    }
  };
  const lanes = await Promise.allSettled(
    Array.from({ length: Math.min(trials, concurrency) }, lane),
  );
  const failure = lanes.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  await records.finishSolverEvaluation(input);
}
