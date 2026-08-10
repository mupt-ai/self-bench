import { describe, expect, test } from "bun:test";
import { RetryState } from "@temporalio/common";
import { ActivityFailure, ApplicationFailure, CancelledFailure } from "@temporalio/workflow";
import type { SelfBenchActivities } from "../src/activities.js";
import type {
  ArtifactRef,
  Candidate,
  Difficulty,
  RunRequest,
  RunStatus,
} from "../src/contracts.js";
import { executeRun } from "../src/workflow.js";

const artifact: ArtifactRef = {
  uri: "file:///artifact",
  sha256: "a".repeat(64),
  sizeBytes: 1,
  contentType: "application/json",
};

const run: RunRequest = {
  runId: "workflow-test",
  repository: { url: "https://github.com/example/repo.git", commit: "a".repeat(40) },
  provenance: artifact,
  candidateCounts: { easy: 0, medium: 0, hard: 1 },
  authoring: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
  version: {
    selfbenchCommit: "b".repeat(40),
    executionBackend: "docker",
    sandboxImage: "selfbench-sandbox:local",
    schema: 1,
  },
};

function candidate(id: string, sourcePr: number, difficulty: Difficulty = "hard"): Candidate {
  return {
    candidateId: id,
    difficulty,
    sourcePr,
    sourceUrl: `https://github.com/example/repo/pull/${sourcePr}`,
    baseCommit: "c".repeat(40),
    completedCommit: "d".repeat(40),
    request: "Implement behavior",
    provenance: artifact,
  };
}

function acceptingActivities(discovered: readonly Candidate[]): SelfBenchActivities {
  return {
    discoverCandidateShard: async ({ shardIndex }) => ({
      candidates: shardIndex === 0 ? discovered : [],
      report: artifact,
    }),
    authorCandidate: async ({ candidate: value }) => ({
      kind: "authored",
      task: {
        candidateId: value.candidateId,
        taskId: `${value.candidateId}-task`,
        definition: artifact,
        bundle: artifact,
      },
    }),
    auditTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
    validateTask: async ({ task }) => ({
      taskId: task.taskId,
      accepted: true,
      nop: { passed: true, result: artifact },
      oracle: { passed: true, result: artifact },
    }),
    repairValidationTask: async () => {
      throw new Error("unexpected validation repair");
    },
    reviewTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
    repairTask: async () => {
      throw new Error("unexpected repair");
    },
    buildExport: async () => artifact,
  };
}

describe("SelfBench workflow", () => {
  test("propagates discovery cancellation", async () => {
    let currentStatus: (() => RunStatus) | undefined;
    const activities = acceptingActivities([]);
    activities.discoverCandidateShard = async () => {
      throw new CancelledFailure("cancelled");
    };

    await expect(
      executeRun(run, activities, (status) => {
        currentStatus = status;
      }),
    ).rejects.toBeInstanceOf(CancelledFailure);
    expect(currentStatus?.().phase).toBe("cancelled");
  });

  test("authors the exact mixed tier budgets and exports accepted tasks", async () => {
    const candidates = [
      candidate("easy-1", 1, "easy"),
      candidate("medium-1", 2, "medium"),
      candidate("hard-1", 3, "hard"),
      candidate("easy-extra", 4, "easy"),
    ];
    const authored: string[] = [];
    let exported: string[] = [];
    const activities = acceptingActivities(candidates);
    activities.authorCandidate = async ({ candidate: value }) => {
      authored.push(`${value.difficulty}:${value.candidateId}`);
      if (value.candidateId === "medium-1") {
        return { kind: "rejected", candidateId: value.candidateId, reason: "not reproducible" };
      }
      return {
        kind: "authored",
        task: {
          candidateId: value.candidateId,
          taskId: `${value.candidateId}-task`,
          definition: artifact,
          bundle: artifact,
        },
      };
    };
    activities.buildExport = async ({ tasks }) => {
      exported = tasks.map((task) => task.taskId);
      return artifact;
    };
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(
      { ...run, candidateCounts: { easy: 1, medium: 1, hard: 1 } },
      activities,
      (status) => {
        currentStatus = status;
      },
    );

    expect(authored.sort()).toEqual(["easy:easy-1", "hard:hard-1", "medium:medium-1"]);
    expect(exported.sort()).toEqual(["easy-1-task", "hard-1-task"]);
    expect([...result.acceptedTaskIds].sort()).toEqual(exported);
    expect(currentStatus?.().requestedByDifficulty).toEqual({ easy: 1, medium: 1, hard: 1 });
    expect(currentStatus?.().accepted).toBe(2);
    expect(currentStatus?.().rejected).toBe(1);
  });

  test("expands discovery only until every tier authoring budget is filled", async () => {
    const targetCounts: Array<Record<Difficulty, number>> = [];
    const activities = acceptingActivities([]);
    activities.discoverCandidateShard = async ({ wave, shardIndex, targetCounts: targets }) => {
      if (shardIndex === 0) {
        targetCounts.push({ ...targets });
      }
      if (shardIndex !== 0) {
        return { candidates: [], report: artifact };
      }
      return {
        candidates:
          wave === 0 ? [candidate("easy", 1, "easy")] : [candidate("medium", 2, "medium")],
        report: artifact,
      };
    };

    const result = await executeRun(
      { ...run, candidateCounts: { easy: 1, medium: 1, hard: 0 } },
      activities,
    );

    expect(targetCounts).toEqual([
      { easy: 4, medium: 4, hard: 0 },
      { easy: 0, medium: 4, hard: 0 },
    ]);
    expect([...result.acceptedTaskIds].sort()).toEqual(["easy-task", "medium-task"]);
  });

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
      throw new Error("Activity task failed", {
        cause: new Error("validation repair sandbox produced no output for 480000ms"),
      });
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
      throw new Error("Activity task failed", {
        cause: new Error("test repair sandbox exited 1"),
      });
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
