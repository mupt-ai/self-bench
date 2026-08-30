import { describe, expect, test } from "bun:test";
import { RetryState } from "@temporalio/common";
import { ActivityFailure, CancelledFailure } from "@temporalio/workflow";
import type { RunStatus } from "../src/contracts.js";
import { executeRun } from "../src/temporal/workflow.js";
import { acceptingActivities, artifact, candidate, run } from "./support/workflow-fixture.js";

describe("SelfBench workflow repair", () => {
  test("propagates cancellation from validation repair", async () => {
    const activities = acceptingActivities([candidate("cancelled-repair", 1)]);
    activities.validateTask = async ({ task }) => ({
      taskId: task.taskId,
      accepted: false,
      nop: { passed: true, result: artifact },
      oracle: { passed: false, result: artifact },
      reason: "oracle failed",
    });
    activities.repairValidationTask = async () => {
      throw new ActivityFailure(
        "Activity task failed",
        "repairValidationTask",
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
  test("repairs a coupled task and repeats every acceptance gate", async () => {
    const calls: string[] = [];
    let reviews = 0;
    const activities = acceptingActivities([candidate("initial", 1)]);
    activities.auditTask = async ({ task }) => {
      calls.push("audit");
      return { taskId: task.taskId, accepted: true, report: artifact };
    };
    activities.validateTask = async ({ task }) => {
      calls.push("validate");
      return {
        taskId: task.taskId,
        accepted: true,
        nop: { passed: true, result: artifact },
        oracle: { passed: true, result: artifact },
      };
    };
    activities.reviewTask = async ({ task }) => {
      calls.push("review");
      reviews += 1;
      return {
        taskId: task.taskId,
        accepted: reviews === 2,
        report: artifact,
        ...(reviews === 1 ? { reason: "gold-only field" } : {}),
      };
    };
    activities.repairTask = async ({ task, review }) => {
      calls.push("repair");
      expect(review).toEqual(artifact);
      return {
        kind: "authored",
        task: { ...task, bundle: { ...artifact, uri: "file:///repaired" } },
      };
    };

    const result = await executeRun(run, activities);

    expect(calls).toEqual(["audit", "validate", "review", "repair", "audit", "validate", "review"]);
    expect(result.acceptedTaskIds).toEqual(["initial-task"]);
  });
  test("rejects only the candidate when test repair fails after retries", async () => {
    const activities = acceptingActivities([candidate("repair-failed", 1)]);
    activities.reviewTask = async ({ task }) => ({
      taskId: task.taskId,
      accepted: false,
      report: artifact,
      reason: "coupled test",
    });
    activities.repairTask = async () => {
      throw new ActivityFailure(
        "Activity task failed",
        "repairTask",
        "activity-id",
        RetryState.MAXIMUM_ATTEMPTS_REACHED,
        "worker",
        new Error("test repair sandbox exited 1"),
      );
    };
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(run, activities, (status) => {
      currentStatus = status;
    });

    expect(result.acceptedTaskIds).toEqual([]);
    expect(currentStatus?.().phase).toBe("complete");
    expect(currentStatus?.().tasks).toEqual([
      expect.objectContaining({
        candidateId: "repair-failed",
        status: "rejected",
        reason: "test repair failed after activity retries",
      }),
    ]);
  });
});
