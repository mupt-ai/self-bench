import { describe, expect, test } from "bun:test";
import { RetryState } from "@temporalio/common";
import { ActivityFailure, ApplicationFailure, ChildWorkflowFailure } from "@temporalio/workflow";
import type { RunStatus, TaskProgress } from "../src/contracts.js";
import {
  type CandidateChildren,
  inProcessCandidates,
} from "../src/temporal/workflow/candidate-tracker.js";
import { executeRun } from "../src/temporal/workflow.js";
import { acceptingActivities, artifact, candidate, ref, run } from "./support/workflow-fixture.js";

describe("SelfBench candidate child workflows", () => {
  test("fails the candidate child on a non-retryable activity failure and completes the run", async () => {
    const activities = acceptingActivities([candidate("invalid", 1), candidate("valid", 2)]);
    const original = activities.runAuthoringRound;
    activities.runAuthoringRound = async (input) => {
      if (input.candidate.candidateId === "invalid") {
        throw new ActivityFailure(
          "Activity task failed",
          "runAuthoringRound",
          "activity-id",
          RetryState.NON_RETRYABLE_FAILURE,
          "worker",
          ApplicationFailure.nonRetryable("invalid task contract", "InvalidTask"),
        );
      }
      return await original(input);
    };
    let currentStatus: (() => RunStatus) | undefined;
    const children = inProcessCandidates(activities);
    const childFailures: string[] = [];

    const result = await executeRun(
      { ...run, candidateCounts: { easy: 0, medium: 0, hard: 2 } },
      activities,
      (status) => {
        currentStatus = status;
      },
      {
        ...children,
        startCandidate: (value, candidateValue) =>
          children.startCandidate(value, candidateValue).catch((error: unknown) => {
            childFailures.push(candidateValue.candidateId);
            throw error;
          }),
      },
    );

    expect(childFailures).toEqual(["invalid"]);
    expect(result.acceptedTaskIds).toEqual(["valid-task"]);
    expect(currentStatus?.().phase).toBe("complete");
    expect(currentStatus?.().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: "invalid",
          status: "infrastructure_failed",
          reason: "invalid task contract",
        }),
        expect.objectContaining({ candidateId: "valid", status: "accepted" }),
      ]),
    );
  });
  test("turns a failed candidate child workflow into an infrastructure failure for that candidate only", async () => {
    const activities = acceptingActivities([candidate("crashed", 1), candidate("healthy", 2)]);
    const children = inProcessCandidates(activities);
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(
      { ...run, candidateCounts: { easy: 0, medium: 0, hard: 2 } },
      activities,
      (status) => {
        currentStatus = status;
      },
      {
        ...children,
        startCandidate: async (value, candidateValue) => {
          if (candidateValue.candidateId === "crashed") {
            throw new ChildWorkflowFailure(
              "default",
              { workflowId: "workflow-test/candidate/crashed", runId: "run-1" },
              "selfBenchCandidateWorkflow",
              RetryState.NON_RETRYABLE_FAILURE,
              ApplicationFailure.nonRetryable("workflow task failed: bad payload", "TypeError"),
            );
          }
          return await children.startCandidate(value, candidateValue);
        },
      },
    );

    expect(result.acceptedTaskIds).toEqual(["healthy-task"]);
    expect(currentStatus?.().phase).toBe("complete");
    expect(currentStatus?.().accepted).toBe(1);
    expect(currentStatus?.().rejected).toBe(0);
    expect(currentStatus?.().tasks).toEqual([
      expect.objectContaining({
        candidateId: "crashed",
        status: "infrastructure_failed",
        reason: "workflow task failed: bad payload",
      }),
      expect.objectContaining({ candidateId: "healthy", status: "accepted" }),
    ]);
  });
  test("applies progress signals from a candidate child to the run status", async () => {
    const activities = acceptingActivities([candidate("signalled", 1)]);
    let signal: ((progress: TaskProgress) => void) | undefined;
    let currentStatus: (() => RunStatus) | undefined;
    const observed: TaskProgress["status"][] = [];
    const children: CandidateChildren = {
      installProgressSignal: (handler) => {
        signal = handler;
      },
      startCandidate: async (_value, candidateValue) => {
        const progress = (
          status: TaskProgress["status"],
          stage: NonNullable<TaskProgress["stage"]>,
          round: number,
        ): TaskProgress => ({
          candidateId: candidateValue.candidateId,
          taskId: "signalled-task",
          difficulty: candidateValue.difficulty,
          status,
          stage,
          round,
        });
        signal?.(progress("verifying", "authoring", 2));
        observed.push(...(currentStatus?.().tasks.map((task) => task.status) ?? []));
        signal?.(progress("reviewing", "verification", 1));
        observed.push(...(currentStatus?.().tasks.map((task) => task.status) ?? []));
        return {
          progress: progress("accepted", "verification", 1),
          task: {
            candidateId: candidateValue.candidateId,
            taskId: "signalled-task",
            definition: artifact,
            sourceBundle: artifact,
            bundle: artifact,
          },
          report: artifact,
        };
      },
    };

    const result = await executeRun(
      run,
      activities,
      (status) => {
        currentStatus = status;
      },
      children,
    );
    signal?.({
      candidateId: "signalled",
      taskId: "signalled-task",
      difficulty: "hard",
      status: "rejected",
      reason: "stale signal after completion",
    });

    expect(observed).toEqual(["verifying", "reviewing"]);
    expect(result.acceptedTaskIds).toEqual(["signalled-task"]);
    expect(currentStatus?.().tasks).toEqual([
      {
        candidateId: "signalled",
        taskId: "signalled-task",
        difficulty: "hard",
        status: "accepted",
        stage: "verification",
        round: 1,
      },
    ]);
    expect(currentStatus?.().accepted).toBe(1);
  });
  test("rejects a second candidate that reuses another candidate's task ID", async () => {
    const activities = acceptingActivities([candidate("one", 1), candidate("two", 2)]);
    activities.runAuthoringRound = async ({ candidate: value, round }) => ({
      kind: "submitted",
      task: {
        candidateId: value.candidateId,
        taskId: "shared",
        definition: artifact,
        sourceBundle: artifact,
      },
      session: ref(`file:///${value.candidateId}/session/round-${round}.jsonl`),
    });
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(
      { ...run, candidateCounts: { easy: 0, medium: 0, hard: 2 } },
      activities,
      (status) => {
        currentStatus = status;
      },
    );

    expect(result.acceptedTaskIds).toEqual(["shared"]);
    expect(currentStatus?.().accepted).toBe(1);
    expect(currentStatus?.().rejected).toBe(1);
    expect(currentStatus?.().tasks).toEqual([
      expect.objectContaining({ candidateId: "one", taskId: "shared", status: "accepted" }),
      expect.objectContaining({
        candidateId: "two",
        taskId: "shared",
        status: "rejected",
        reason: "authoring repeated task ID shared already claimed by one",
      }),
    ]);
  });
});
