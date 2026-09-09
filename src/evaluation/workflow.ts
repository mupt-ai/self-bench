import { ActivityCancellationType, CancellationScope, proxyActivities } from "@temporalio/workflow";
import type { EvaluationActivities } from "./activities.js";
import type { EvaluationInput } from "./types.js";

const solver = proxyActivities<EvaluationActivities>({
  startToCloseTimeout: "72 hours",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});
const finalizer = proxyActivities<EvaluationActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});
export async function selfBenchEvaluationWorkflow(input: EvaluationInput): Promise<void> {
  try {
    await solver.executeSolverEvaluation(input);
  } catch {
    await CancellationScope.nonCancellable(() => finalizer.failSolverEvaluation(input));
  }
}
