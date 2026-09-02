import { describe, expect, test } from "bun:test";
import { RetryState } from "@temporalio/common";
import { ActivityFailure, ApplicationFailure, CancelledFailure } from "@temporalio/workflow";
import type { RunStatus } from "../src/contracts.js";
import { executeRun } from "../src/temporal/workflow.js";
import {
  acceptingActivities,
  artifact,
  candidate,
  greenOutcome,
  redReport,
  ref,
  run,
} from "./support/workflow-fixture.js";

describe("SelfBench workflow processing", () => {
  test("backfills a rejected candidate from the leftover discovery pool", async () => {
    const activities = acceptingActivities([
      candidate("first", 1),
      candidate("reserve", 2),
      candidate("unused", 3),
    ]);
    const authored: string[] = [];
    const original = activities.runAuthoringRound;
    activities.runAuthoringRound = async (input) => {
      authored.push(input.candidate.candidateId);
      if (input.candidate.candidateId === "first") {
        return { kind: "rejected", candidateId: "first", reason: "not viable" };
      }
      return await original(input);
    };
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(run, activities, (status) => {
      currentStatus = status;
    });

    expect(authored).toEqual(["first", "reserve"]);
    expect(result.acceptedTaskIds).toEqual(["reserve-task"]);
    expect(currentStatus?.().accepted).toBe(1);
    expect(currentStatus?.().rejected).toBe(1);
    expect(currentStatus?.().tasks.map((task) => task.candidateId)).toEqual(["first", "reserve"]);
  });
  test("backfills per tier and stops when the pool has no matching candidate left", async () => {
    const activities = acceptingActivities([
      candidate("easy-a", 1, "easy"),
      candidate("hard-a", 2, "hard"),
      candidate("hard-b", 3, "hard"),
      candidate("easy-b", 4, "easy"),
    ]);
    const original = activities.runAuthoringRound;
    activities.runAuthoringRound = async (input) => {
      if (input.candidate.candidateId.startsWith("easy")) {
        return { kind: "rejected", candidateId: input.candidate.candidateId, reason: "no seam" };
      }
      return await original(input);
    };

    const result = await executeRun(
      { ...run, candidateCounts: { easy: 1, medium: 0, hard: 1 } },
      activities,
    );

    expect(result.acceptedTaskIds).toEqual(["hard-a-task"]);
  });
  test("records exhausted Harbor infrastructure failure and replaces the candidate", async () => {
    const activities = acceptingActivities([candidate("infra", 1), candidate("reserve", 2)]);
    const original = activities.compileAndVerify;
    activities.compileAndVerify = async (input) => {
      if (input.candidate.candidateId === "infra") {
        throw new Error("Activity task failed", {
          cause: ApplicationFailure.retryable(
            "Modal image build failed after retries",
            "HarborInfrastructureFailure",
          ),
        });
      }
      return await original(input);
    };
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(run, activities, (status) => {
      currentStatus = status;
    });

    expect(result.acceptedTaskIds).toEqual(["reserve-task"]);
    expect(currentStatus?.().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: "infra",
          difficulty: "hard",
          status: "infrastructure_failed",
          reason: "Modal image build failed after retries",
        }),
      ]),
    );
  });
  test("turns three consecutive infrastructure rounds into an infrastructure failure", async () => {
    const activities = acceptingActivities([candidate("flaky", 1)]);
    activities.compileAndVerify = async ({ task, round }) => ({
      report: redReport("authoring", round, task.taskId, { infrastructure: "ImageBuildError" }),
      reportRef: ref(`file:///report-${round}`),
    });
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(run, activities, (status) => {
      currentStatus = status;
    });

    expect(result.acceptedTaskIds).toEqual([]);
    expect(currentStatus?.().tasks).toEqual([
      expect.objectContaining({
        candidateId: "flaky",
        status: "infrastructure_failed",
        reason: expect.stringContaining("3 consecutive authoring rounds"),
      }),
    ]);
  });
  test("counts an infrastructure round as a round the author can retry", async () => {
    const activities = acceptingActivities([candidate("retry", 1)]);
    activities.compileAndVerify = async ({ task, stage, round }) =>
      round === 1 && stage === "authoring"
        ? {
            report: redReport(stage, round, task.taskId, { infrastructure: "ImageBuildError" }),
            reportRef: ref("file:///report-1"),
          }
        : greenOutcome(task, stage, round);

    const result = await executeRun(run, activities);

    expect(result.acceptedTaskIds).toEqual(["retry-task"]);
  });
  test("isolates an exhausted authoring activity and completes successful siblings", async () => {
    const activities = acceptingActivities([
      candidate("timed-out", 1),
      candidate("successful-sibling", 2),
    ]);
    const originalAuthor = activities.runAuthoringRound;
    activities.runAuthoringRound = async (input) => {
      if (input.candidate.candidateId === "timed-out") {
        throw new ActivityFailure(
          "Activity task failed",
          "runAuthoringRound",
          "activity-id",
          RetryState.MAXIMUM_ATTEMPTS_REACHED,
          "worker",
          ApplicationFailure.retryable(
            "author sandbox produced no output for 480000ms; partial log: file:///modal.log",
            "Error",
          ),
        );
      }
      return await originalAuthor(input);
    };
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(
      { ...run, candidateCounts: { easy: 0, medium: 0, hard: 2 } },
      activities,
      (status) => {
        currentStatus = status;
      },
    );

    expect(result.acceptedTaskIds).toEqual(["successful-sibling-task"]);
    expect(currentStatus?.().phase).toBe("complete");
    expect(currentStatus?.().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: "timed-out",
          status: "infrastructure_failed",
          reason: expect.stringContaining("partial log: file:///modal.log"),
        }),
        expect.objectContaining({ candidateId: "successful-sibling", status: "accepted" }),
      ]),
    );
  });
  test("propagates non-retryable candidate activity failures", async () => {
    const activities = acceptingActivities([candidate("invalid", 1)]);
    activities.runAuthoringRound = async () => {
      throw new ActivityFailure(
        "Activity task failed",
        "runAuthoringRound",
        "activity-id",
        RetryState.NON_RETRYABLE_FAILURE,
        "worker",
        ApplicationFailure.nonRetryable("invalid task contract", "InvalidTask"),
      );
    };
    let currentStatus: (() => RunStatus) | undefined;

    await expect(
      executeRun(run, activities, (status) => {
        currentStatus = status;
      }),
    ).rejects.toBeInstanceOf(ActivityFailure);
    expect(currentStatus?.().phase).toBe("failed");
  });
  test("propagates cancellation from a verifier round", async () => {
    const activities = acceptingActivities([candidate("cancelled", 1)]);
    activities.runVerifierRound = async () => {
      throw new ActivityFailure(
        "Activity task failed",
        "runVerifierRound",
        "activity-id",
        RetryState.CANCEL_REQUESTED,
        "worker",
        new CancelledFailure("cancelled"),
      );
    };
    let currentStatus: (() => RunStatus) | undefined;

    await expect(
      executeRun(run, activities, (status) => {
        currentStatus = status;
      }),
    ).rejects.toBeInstanceOf(ActivityFailure);
    expect(currentStatus?.().phase).toBe("cancelled");
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
    expect(currentStatus?.().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "rejected",
          reason: expect.stringContaining("repeated task ID shared"),
        }),
      ]),
    );
  });
});
