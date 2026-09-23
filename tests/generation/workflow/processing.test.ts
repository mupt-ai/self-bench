import { describe, expect, test } from "bun:test";
import { RetryState } from "@temporalio/common";
import { ActivityFailure, ApplicationFailure, CancelledFailure } from "@temporalio/workflow";
import type { RunStatus } from "../../../src/contracts/index.js";
import {
  acceptingActivities,
  authorCandidates,
  candidate,
  greenOutcome,
  redReport,
  ref,
} from "../../support/workflow-fixture.js";

describe("SelfBench workflow processing", () => {
  test("counts an infrastructure round as a round the author can retry", async () => {
    const activities = acceptingActivities([candidate("retry", 1)]);
    activities.compileAndVerify = async ({ task, stage, round }) =>
      round === 1 && stage === "authoring"
        ? {
            report: redReport(stage, round, task.taskId, { infrastructure: "ImageBuildError" }),
            reportRef: ref("file:///report-1"),
          }
        : greenOutcome(task, stage, round);

    const result = await authorCandidates(activities);

    expect(result.acceptedTaskIds).toEqual(["retry-task"]);
  });
  test("isolates an exhausted authoring activity and completes successful siblings", async () => {
    const activities = acceptingActivities([
      candidate("timed-out", 1),
      candidate("successful-sibling", 2),
    ]);
    const originalAuthor = activities.runAuthoringTurn;
    activities.runAuthoringTurn = async (input) => {
      if (input.candidate.candidateId === "timed-out") {
        throw new ActivityFailure(
          "Activity task failed",
          "runAuthoringTurn",
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

    const result = await authorCandidates(activities, (status) => {
      currentStatus = status;
    });

    expect(result.acceptedTaskIds).toEqual(["successful-sibling-task"]);
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
  test("propagates cancellation from a review round", async () => {
    const activities = acceptingActivities([candidate("cancelled", 1)]);
    activities.runReviewRound = async () => {
      throw new ActivityFailure(
        "Activity task failed",
        "runReviewRound",
        "activity-id",
        RetryState.CANCEL_REQUESTED,
        "worker",
        new CancelledFailure("cancelled"),
      );
    };
    await expect(authorCandidates(activities)).rejects.toBeInstanceOf(ActivityFailure);
  });
});
