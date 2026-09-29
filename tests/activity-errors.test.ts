import { expect, test } from "bun:test";
import { CancelledFailure, CompleteAsyncError, type Context } from "@temporalio/activity";
import { activityErrorInterceptor } from "../src/temporal/activity-errors.js";

const context = {
  info: {
    activityType: "runSolverTrial",
    activityId: "1",
    attempt: 3,
    taskQueue: "selfbench-dev-harbor",
    workflowExecution: { workflowId: "eval-one/trial/one", runId: "r" },
    workflowType: "solverTrialWorkflow",
  },
} as unknown as Context;

function run(failure: unknown) {
  const reports: { error: unknown; tags: unknown }[] = [];
  const execute = activityErrorInterceptor((error, { tags } = {}) => reports.push({ error, tags }))(
    context,
  ).inbound?.execute;
  if (!execute) throw new Error("no inbound interceptor");
  const result = execute({ args: [], headers: {} }, async () => Promise.reject(failure));
  return { result, reports };
}

test("a failed attempt is reported with what failed, then rethrown for Temporal to retry", async () => {
  const failure = new Error("harbor exited 1");
  const { result, reports } = run(failure);
  await expect(result).rejects.toBe(failure);
  expect(reports).toEqual([
    {
      error: failure,
      tags: {
        activity_type: "runSolverTrial",
        workflow_type: "solverTrialWorkflow",
        attempt: 3,
        task_queue: "selfbench-dev-harbor",
      },
    },
  ]);
});

test.each([
  ["handed to a started sandbox", new CompleteAsyncError()],
  ["cancelled", new CancelledFailure("CANCELLED")],
])("an activity %s is not reported", async (_, ending) => {
  const { result, reports } = run(ending);
  await expect(result).rejects.toBe(ending);
  expect(reports).toHaveLength(0);
});
