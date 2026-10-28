import { expect, test } from "bun:test";
import { RetryState } from "@temporalio/common";
import { CancelledFailure, ChildWorkflowFailure, TerminatedFailure } from "@temporalio/workflow";
import { runEvaluationTrials, runTrial } from "../src/evaluation/workflow.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

function workflowActivities(runSolverTrial: (index: number) => Promise<void>) {
  const events: string[] = [];
  return {
    events,
    records: {
      startSolverEvaluation: async () => 5,
      failSolverTrial: async (_input: unknown, index: number) => {
        events.push(`fail ${index}`);
      },
      finishSolverEvaluation: async () => {
        events.push("finish");
      },
    },
    solve: (_input: unknown, index: number) => runSolverTrial(index),
  };
}

test("the workflow bounds trials in flight and fails only a trial whose activity failed", async () => {
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  const { events, records, solve } = workflowActivities(async (index) => {
    started.push(index);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    if (index === 1) throw new Error("Heartbeat timeout");
  });
  await runEvaluationTrials(evaluationInput(), records, solve, 2);
  expect(peak).toBe(2);
  expect(started.sort()).toEqual([0, 1, 2, 3, 4]);
  expect(events).toEqual(["fail 1", "finish"]);
});

test("a cancelled workflow waits for running trials and records no outcome", async () => {
  let settled = 0;
  const { events, records, solve } = workflowActivities(async (index) => {
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 1 : 20));
    settled += 1;
    throw new CancelledFailure("Activity cancelled");
  });
  await expect(runEvaluationTrials(evaluationInput(), records, solve, 3)).rejects.toThrow(
    "Activity cancelled",
  );
  expect(settled).toBe(3);
  expect(events).toEqual([]);
});

test("a trial workflow cancelled with its evaluation is not failed, but a terminated one is", async () => {
  const child = (cause: Error) =>
    new ChildWorkflowFailure(
      "default",
      { workflowId: "evaluation/1/run/trial/0" },
      "selfBenchSolverTrialWorkflow",
      RetryState.NON_RETRYABLE_FAILURE,
      cause,
    );
  const { events, records } = workflowActivities(async () => {});
  const cancelled = { runSolverTrial: () => Promise.reject(child(new CancelledFailure("x"))) };
  await expect(runTrial(evaluationInput(), 0, cancelled, records)).rejects.toThrow();
  const terminated = { runSolverTrial: () => Promise.reject(child(new TerminatedFailure("x"))) };
  await runTrial(evaluationInput(), 1, terminated, records);
  expect(events).toEqual(["fail 1"]);
});
