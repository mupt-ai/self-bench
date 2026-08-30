import { describe, expect, test } from "bun:test";
import { RetryState } from "@temporalio/common";
import { ActivityFailure, CancelledFailure } from "@temporalio/workflow";
import type { Difficulty, RunStatus } from "../src/contracts.js";
import { executeRun } from "../src/temporal/workflow.js";
import {
  acceptingActivities,
  artifact,
  candidate,
  combinedProvenance,
  run,
} from "./support/workflow-fixture.js";

describe("SelfBench workflow discovery", () => {
  test("uses remotely collected pull request provenance for discovery", async () => {
    const activities = acceptingActivities([candidate("candidate", 1)]);
    activities.collectRunProvenance = async () => combinedProvenance;
    activities.discoverCandidateShard = async ({ run: discoveryRun, shardIndex }) => {
      expect(discoveryRun.provenance).toEqual(combinedProvenance);
      return {
        candidates: shardIndex === 0 ? [candidate("candidate", 1)] : [],
        report: artifact,
      };
    };

    await executeRun(run, activities);
  });
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
  test("tolerates only retry-exhausted discovery shards", async () => {
    const activities = acceptingActivities([]);
    activities.discoverCandidateShard = async ({ shardIndex }) => {
      if (shardIndex === 0) {
        throw new ActivityFailure(
          "Activity task failed",
          "discoverCandidateShard",
          "activity-id",
          RetryState.MAXIMUM_ATTEMPTS_REACHED,
          "worker",
          new Error("discovery sandbox unavailable"),
        );
      }
      return {
        candidates: shardIndex === 1 ? [candidate("surviving-candidate", 1)] : [],
        report: artifact,
      };
    };

    const result = await executeRun(run, activities);

    expect(result.acceptedTaskIds).toEqual(["surviving-candidate-task"]);
  });
  test("propagates deterministic discovery errors", async () => {
    const activities = acceptingActivities([]);
    activities.discoverCandidateShard = async ({ shardIndex }) => {
      if (shardIndex === 0) {
        throw new Error("invalid discovery implementation");
      }
      return {
        candidates: [candidate(`candidate-${shardIndex}`, shardIndex + 1)],
        report: artifact,
      };
    };
    let currentStatus: (() => RunStatus) | undefined;

    await expect(
      executeRun(run, activities, (status) => {
        currentStatus = status;
      }),
    ).rejects.toThrow("invalid discovery implementation");
    expect(currentStatus?.().phase).toBe("failed");
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
          sourceBundle: artifact,
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
  test("bounds candidate activity fanout for large runs", async () => {
    const candidates = Array.from({ length: 101 }, (_unused, index) =>
      candidate(`candidate-${index}`, index + 1),
    );
    const activities = acceptingActivities(candidates);
    let active = 0;
    let peak = 0;
    activities.authorCandidate = async ({ candidate: value }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return {
        kind: "authored",
        task: {
          candidateId: value.candidateId,
          taskId: `${value.candidateId}-task`,
          definition: artifact,
          sourceBundle: artifact,
        },
      };
    };

    const result = await executeRun(
      { ...run, candidateCounts: { easy: 0, medium: 0, hard: candidates.length } },
      activities,
    );

    expect(peak).toBe(100);
    expect(result.acceptedTaskIds).toHaveLength(candidates.length);
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
});
