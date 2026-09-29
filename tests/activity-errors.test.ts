import { expect, test } from "bun:test";
import {
  ApplicationFailure,
  CancelledFailure,
  CompleteAsyncError,
  type Context,
} from "@temporalio/activity";
import { activityErrorInterceptor } from "../src/temporal/activity-errors.js";

function run(failure: unknown, attempt: number) {
  const context = {
    info: {
      activityType: "runSolverTrial",
      activityId: "1",
      attempt,
      taskQueue: "selfbench-dev-harbor",
      workflowExecution: { workflowId: "eval-one/trial/one", runId: "r" },
      workflowType: "solverTrialWorkflow",
    },
  } as unknown as Context;
  const reports: { error: unknown; tags: unknown }[] = [];
  const execute = activityErrorInterceptor((error, { tags } = {}) => reports.push({ error, tags }))(
    context,
  ).inbound?.execute;
  if (!execute) throw new Error("no inbound interceptor");
  const result = execute({ args: [], headers: {} }, async () => Promise.reject(failure));
  return { result, reports };
}

test("a first failed attempt is reported with what failed, then rethrown for Temporal to retry", async () => {
  const failure = new Error("harbor exited 1");
  const { result, reports } = run(failure, 1);
  await expect(result).rejects.toBe(failure);
  expect(reports).toEqual([
    {
      error: failure,
      tags: {
        activity_type: "runSolverTrial",
        workflow_type: "solverTrialWorkflow",
        attempt: 1,
        task_queue: "selfbench-dev-harbor",
      },
    },
  ]);
});

test.each([
  ["a retry of a failure", new Error("harbor exited 1"), 3, false],
  [
    "a failure that ends retries",
    ApplicationFailure.nonRetryable("unsafe task", "Unsafe"),
    3,
    true,
  ],
  ["a server timeout", new CancelledFailure("TIMED_OUT"), 2, true],
  ["a cancellation", new CancelledFailure("CANCELLED"), 1, false],
  ["a hand-off to a started sandbox", new CompleteAsyncError(), 1, false],
  [
    "a user's generation settings",
    ApplicationFailure.nonRetryable("bad key", "GenerationConfiguration"),
    1,
    false,
  ],
])("%s", async (_, failure, attempt, reported) => {
  const { result, reports } = run(failure, attempt);
  await expect(result).rejects.toBe(failure);
  expect(reports).toHaveLength(reported ? 1 : 0);
});
