import { describe, expect, test } from "bun:test";
import { RetryState } from "@temporalio/common";
import { ActivityFailure, ApplicationFailure } from "@temporalio/workflow";
import type { RunStatus } from "../src/contracts.js";
import { executeRun } from "../src/temporal/workflow.js";
import { acceptingActivities, artifact, candidate, run } from "./support/workflow-fixture.js";

describe("SelfBench workflow processing", () => {
  test("does not replace a rejected candidate", async () => {
    const activities = acceptingActivities([
      candidate("first", 1),
      candidate("would-be-reserve", 2),
    ]);
    const authored: string[] = [];
    activities.authorCandidate = async ({ candidate: value }) => {
      authored.push(value.candidateId);
      return { kind: "rejected", candidateId: value.candidateId, reason: "not viable" };
    };

    const result = await executeRun(run, activities);

    expect(authored).toEqual(["first"]);
    expect(result.acceptedTaskIds).toEqual([]);
  });
  test("repairs a failed environment twice before validation", async () => {
    const activities = acceptingActivities([candidate("environment-repair", 1)]);
    const calls: string[] = [];
    let preflights = 0;
    activities.authorEnvironment = async ({ task, previousTask, diagnostics }) => {
      calls.push(previousTask ? "repair-environment" : "author-environment");
      if (previousTask) {
        expect(diagnostics).toBe(`build failure ${preflights}`);
      }
      return {
        kind: "authored",
        task: {
          ...task,
          definition: { ...artifact, uri: `file:///environment-${calls.length}.json` },
          bundle: { ...artifact, uri: `file:///environment-${calls.length}.tar.gz` },
        },
      };
    };
    activities.auditTask = async ({ task }) => {
      calls.push("audit");
      return { taskId: task.taskId, accepted: true, report: artifact };
    };
    activities.preflightEnvironment = async ({ task }) => {
      calls.push("preflight");
      preflights += 1;
      return {
        taskId: task.taskId,
        accepted: preflights === 3,
        report: artifact,
        ...(preflights < 3 ? { reason: `build failure ${preflights}` } : {}),
      };
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

    const result = await executeRun(run, activities);

    expect(result.acceptedTaskIds).toEqual(["environment-repair-task"]);
    expect(calls).toEqual([
      "author-environment",
      "audit",
      "preflight",
      "repair-environment",
      "preflight",
      "repair-environment",
      "preflight",
      "validate",
    ]);
  });
  test("records exhausted Harbor infrastructure failure without replacement", async () => {
    const activities = acceptingActivities([candidate("infra", 1), candidate("reserve", 2)]);
    activities.validateTask = async () => {
      throw new Error("Activity task failed", {
        cause: ApplicationFailure.retryable(
          "Modal image build failed after retries",
          "HarborInfrastructureFailure",
        ),
      });
    };
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(run, activities, (status) => {
      currentStatus = status;
    });

    expect(result.acceptedTaskIds).toEqual([]);
    expect(currentStatus?.().tasks).toEqual([
      expect.objectContaining({
        candidateId: "infra",
        difficulty: "hard",
        status: "infrastructure_failed",
        reason: "Modal image build failed after retries",
      }),
    ]);
  });
  test("isolates an exhausted authoring activity and completes successful siblings", async () => {
    const activities = acceptingActivities([
      candidate("timed-out", 1),
      candidate("successful-sibling", 2),
    ]);
    const originalAuthor = activities.authorCandidate;
    activities.authorCandidate = async (input) => {
      if (input.candidate.candidateId === "timed-out") {
        throw new ActivityFailure(
          "Activity task failed",
          "authorCandidate",
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
    activities.authorCandidate = async () => {
      throw new ActivityFailure(
        "Activity task failed",
        "authorCandidate",
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
  test("repairs a failed validation once and repeats audit and validation", async () => {
    const calls: string[] = [];
    let validations = 0;
    const activities = acceptingActivities([candidate("initial", 1)]);
    activities.auditTask = async ({ task }) => {
      calls.push("audit");
      return { taskId: task.taskId, accepted: true, report: artifact };
    };
    activities.validateTask = async ({ task }) => {
      calls.push("validate");
      validations += 1;
      return {
        taskId: task.taskId,
        accepted: validations === 2,
        nop: { passed: true, result: artifact },
        oracle: { passed: validations === 2, result: artifact },
        ...(validations === 1 ? { reason: "test command failed" } : {}),
      };
    };
    activities.repairValidationTask = async ({ task, validation }) => {
      calls.push("validation-repair");
      expect(validation.reason).toBe("test command failed");
      return {
        kind: "authored",
        task: { ...task, bundle: { ...artifact, uri: "file:///validation-repaired" } },
      };
    };
    activities.reviewTask = async ({ task }) => {
      calls.push("review");
      return { taskId: task.taskId, accepted: true, report: artifact };
    };

    const result = await executeRun(run, activities);

    expect(calls).toEqual([
      "audit",
      "validate",
      "validation-repair",
      "audit",
      "validate",
      "review",
    ]);
    expect(result.acceptedTaskIds).toEqual(["initial-task"]);
  });
  test("rejects only the candidate when validation repair exhausts its one attempt", async () => {
    const activities = acceptingActivities([
      candidate("timed-out", 1),
      candidate("successful-sibling", 2),
    ]);
    activities.validateTask = async ({ task }) => ({
      taskId: task.taskId,
      accepted: task.candidateId === "successful-sibling",
      nop: { passed: true, result: artifact },
      oracle: { passed: task.candidateId === "successful-sibling", result: artifact },
      ...(task.candidateId === "successful-sibling" ? {} : { reason: "oracle failed" }),
    });
    activities.repairValidationTask = async () => {
      throw new ActivityFailure(
        "Activity task failed",
        "repairValidationTask",
        "activity-id",
        RetryState.MAXIMUM_ATTEMPTS_REACHED,
        "worker",
        new Error("validation repair sandbox produced no output for 480000ms"),
      );
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
    expect(currentStatus?.().accepted).toBe(1);
    expect(currentStatus?.().rejected).toBe(1);
    expect(currentStatus?.().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: "timed-out",
          status: "rejected",
          reason: "validation repair failed after its single activity attempt",
        }),
        expect.objectContaining({
          candidateId: "successful-sibling",
          status: "accepted",
        }),
      ]),
    );
  });
});
