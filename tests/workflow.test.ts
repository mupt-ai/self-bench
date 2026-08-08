import { describe, expect, test } from "bun:test";
import { ApplicationFailure, CancelledFailure } from "@temporalio/workflow";
import type { SelfBenchActivities } from "../src/activities.js";
import type { ArtifactRef, Candidate, RunRequest, RunStatus } from "../src/contracts.js";
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
  count: 1,
  reserveCount: 1,
  authoring: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
  version: {
    selfbenchCommit: "b".repeat(40),
    executionBackend: "docker",
    sandboxImage: "selfbench-sandbox:local",
    schema: 1,
  },
};

function candidate(id: string, sourcePr: number): Candidate {
  return {
    candidateId: id,
    sourcePr,
    sourceUrl: `https://github.com/example/repo/pull/${sourcePr}`,
    baseCommit: "c".repeat(40),
    completedCommit: "d".repeat(40),
    request: "Implement behavior",
    provenance: artifact,
  };
}

describe("SelfBench workflow", () => {
  test("propagates discovery cancellation instead of treating shards as exhausted", async () => {
    let currentStatus: (() => RunStatus) | undefined;
    const activities: SelfBenchActivities = {
      discoverCandidateShard: async () => {
        throw new CancelledFailure("cancelled");
      },
      authorCandidate: async () => {
        throw new Error("unexpected authoring");
      },
      auditTask: async () => {
        throw new Error("unexpected audit");
      },
      validateTask: async () => {
        throw new Error("unexpected validation");
      },
      reviewTask: async () => {
        throw new Error("unexpected review");
      },
      repairTask: async () => {
        throw new Error("unexpected repair");
      },
      buildExport: async () => {
        throw new Error("unexpected export");
      },
    };

    await expect(
      executeRun(run, activities, (status) => {
        currentStatus = status;
      }),
    ).rejects.toBeInstanceOf(CancelledFailure);
    expect(currentStatus?.().phase).toBe("cancelled");
  });

  test("runs eight discovery shards concurrently and tolerates a failed duplicate shard", async () => {
    let activeShards = 0;
    let maxActiveShards = 0;
    let authored = 0;
    let currentStatus: (() => RunStatus) | undefined;
    const activities: SelfBenchActivities = {
      discoverCandidateShard: async ({ shardIndex }) => {
        activeShards += 1;
        maxActiveShards = Math.max(maxActiveShards, activeShards);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeShards -= 1;
        if (shardIndex === 7) {
          throw new Error("exhausted retryable shard");
        }
        return { candidates: [candidate(`candidate-${shardIndex}`, 1)], report: artifact };
      },
      authorCandidate: async ({ candidate: value }) => {
        authored += 1;
        return {
          kind: "authored",
          task: {
            candidateId: value.candidateId,
            taskId: "accepted-task",
            definition: artifact,
            bundle: artifact,
          },
        };
      },
      auditTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
      validateTask: async ({ task }) => ({
        taskId: task.taskId,
        accepted: true,
        nop: { passed: true, result: artifact },
        oracle: { passed: true, result: artifact },
      }),
      reviewTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
      repairTask: async () => {
        throw new Error("unexpected repair");
      },
      buildExport: async () => artifact,
    };

    await executeRun({ ...run, reserveCount: 0 }, activities, (status) => {
      currentStatus = status;
    });

    expect(maxActiveShards).toBe(8);
    expect(authored).toBe(1);
    expect(currentStatus?.().discovered).toBe(1);
    expect(currentStatus?.().discovery).toMatchObject({
      totalShards: 8,
      completedShards: 7,
      failedShards: 1,
    });
  });

  test("starts a reserve as soon as a candidate slot rejects", async () => {
    const first = candidate("first", 1);
    const slow = candidate("slow", 2);
    const reserve = candidate("reserve", 3);
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowFinished = false;
    let reserveStartedBeforeSlow = false;
    const activities: SelfBenchActivities = {
      discoverCandidateShard: async ({ shardIndex }) => ({
        candidates: shardIndex === 0 ? [first, slow, reserve] : [],
        report: artifact,
      }),
      authorCandidate: async ({ candidate: value }) => {
        if (value.candidateId === first.candidateId) {
          return { kind: "rejected", candidateId: value.candidateId, reason: "not viable" };
        }
        if (value.candidateId === slow.candidateId) {
          await slowGate;
          slowFinished = true;
        } else {
          reserveStartedBeforeSlow = !slowFinished;
          releaseSlow?.();
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
      },
      auditTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
      validateTask: async ({ task }) => ({
        taskId: task.taskId,
        accepted: true,
        nop: { passed: true, result: artifact },
        oracle: { passed: true, result: artifact },
      }),
      reviewTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
      repairTask: async () => {
        throw new Error("unexpected repair");
      },
      buildExport: async () => artifact,
    };

    const result = await executeRun({ ...run, count: 2, reserveCount: 1 }, activities);

    expect(reserveStartedBeforeSlow).toBe(true);
    expect([...result.acceptedTaskIds].sort()).toEqual(["reserve-task", "slow-task"]);
  });

  test("consumes a reserve after exhausted Harbor infrastructure retries", async () => {
    const activities: SelfBenchActivities = {
      discoverCandidateShard: async ({ shardIndex }) => ({
        candidates: shardIndex === 0 ? [candidate("infra", 1), candidate("reserve", 2)] : [],
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
      validateTask: async ({ task }) => {
        if (task.taskId === "infra-task") {
          throw new Error("Activity task failed", {
            cause: ApplicationFailure.retryable(
              "Modal image build failed after retries",
              "HarborInfrastructureFailure",
            ),
          });
        }
        return {
          taskId: task.taskId,
          accepted: true,
          nop: { passed: true, result: artifact },
          oracle: { passed: true, result: artifact },
        };
      },
      reviewTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
      repairTask: async () => {
        throw new Error("unexpected repair");
      },
      buildExport: async () => artifact,
    };
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(run, activities, (status) => {
      currentStatus = status;
    });

    expect(result.acceptedTaskIds).toEqual(["reserve-task"]);
    expect(currentStatus?.().phase).toBe("complete");
    expect(currentStatus?.().rejected).toBe(0);
    expect(currentStatus?.().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "infra-task",
          status: "infrastructure_failed",
          reason: "Modal image build failed after retries",
        }),
      ]),
    );
  });

  test("consumes a reserve after candidate rejection and exports exactly the target", async () => {
    const authored: string[] = [];
    const stages: string[] = [];
    const activities: SelfBenchActivities = {
      discoverCandidateShard: async ({ shardIndex }) => ({
        candidates: shardIndex === 0 ? [candidate("first", 1), candidate("reserve", 2)] : [],
        report: artifact,
      }),
      authorCandidate: async ({ candidate: value }) => {
        authored.push(value.candidateId);
        return value.candidateId === "first"
          ? { kind: "rejected", candidateId: value.candidateId, reason: "not reproducible" }
          : {
              kind: "authored",
              task: {
                candidateId: value.candidateId,
                taskId: "accepted-task",
                definition: artifact,
                bundle: artifact,
              },
            };
      },
      validateTask: async ({ task }) => {
        stages.push("validate");
        return {
          taskId: task.taskId,
          accepted: true,
          nop: { passed: true, result: artifact },
          oracle: { passed: true, result: artifact },
        };
      },
      reviewTask: async ({ task }) => {
        stages.push("review");
        return { taskId: task.taskId, accepted: true, report: artifact };
      },
      repairTask: async () => {
        throw new Error("unexpected repair");
      },
      auditTask: async ({ task }) => {
        stages.push("audit");
        return { taskId: task.taskId, accepted: true, report: artifact };
      },
      buildExport: async () => artifact,
    };
    let currentStatus: (() => RunStatus) | undefined;
    const result = await executeRun(run, activities, (status) => {
      currentStatus = status;
    });

    expect(authored).toEqual(["first", "reserve"]);
    expect(stages).toEqual(["audit", "validate", "review"]);
    expect(result.acceptedTaskIds).toEqual(["accepted-task"]);
    expect(currentStatus?.().phase).toBe("complete");
    expect(currentStatus?.().rejected).toBe(1);
  });

  test("expands discovery after the initial candidate pool is exhausted", async () => {
    const expanded = candidate("expanded", 2);
    let expansionCalls = 0;
    const activities: SelfBenchActivities = {
      discoverCandidateShard: async ({ excludedSourcePrs, wave, shardIndex }) => {
        if (wave === 0) {
          return {
            candidates: shardIndex === 0 ? [candidate("initial", 1)] : [],
            report: artifact,
          };
        }
        expansionCalls += 1;
        expect(excludedSourcePrs).toEqual([1]);
        expect(wave).toBe(1);
        return { candidates: shardIndex === 0 ? [expanded] : [], report: artifact };
      },
      authorCandidate: async ({ candidate: value }) =>
        value.candidateId === "initial"
          ? { kind: "rejected", candidateId: value.candidateId, reason: "not reproducible" }
          : {
              kind: "authored",
              task: {
                candidateId: value.candidateId,
                taskId: "expanded-task",
                definition: artifact,
                bundle: artifact,
              },
            },
      validateTask: async ({ task }) => ({
        taskId: task.taskId,
        accepted: true,
        nop: { passed: true, result: artifact },
        oracle: { passed: true, result: artifact },
      }),
      reviewTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
      repairTask: async () => {
        throw new Error("unexpected repair");
      },
      auditTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
      buildExport: async () => artifact,
    };

    const result = await executeRun({ ...run, reserveCount: 0 }, activities);

    expect(expansionCalls).toBe(8);
    expect(result.acceptedTaskIds).toEqual(["expanded-task"]);
  });

  test("repairs a coupled task and repeats every acceptance gate", async () => {
    const calls: string[] = [];
    let reviews = 0;
    const task = {
      candidateId: "initial",
      taskId: "repaired-task",
      definition: artifact,
      bundle: artifact,
    };
    const activities: SelfBenchActivities = {
      discoverCandidateShard: async ({ shardIndex }) => ({
        candidates: shardIndex === 0 ? [candidate("initial", 1)] : [],
        report: artifact,
      }),
      authorCandidate: async () => ({ kind: "authored", task }),
      auditTask: async ({ task: value }) => {
        calls.push("audit");
        return { taskId: value.taskId, accepted: true, report: artifact };
      },
      validateTask: async ({ task: value }) => {
        calls.push("validate");
        return {
          taskId: value.taskId,
          accepted: true,
          nop: { passed: true, result: artifact },
          oracle: { passed: true, result: artifact },
        };
      },
      reviewTask: async ({ task: value }) => {
        calls.push("review");
        reviews += 1;
        return {
          taskId: value.taskId,
          accepted: reviews === 2,
          report: artifact,
          ...(reviews === 1 ? { reason: "gold-only field" } : {}),
        };
      },
      repairTask: async ({ task: value, review }) => {
        calls.push("repair");
        expect(review).toEqual(artifact);
        return {
          kind: "authored",
          task: { ...value, bundle: { ...artifact, uri: "file:///repaired" } },
        };
      },
      buildExport: async () => artifact,
    };

    const result = await executeRun({ ...run, reserveCount: 0 }, activities);

    expect(calls).toEqual(["audit", "validate", "review", "repair", "audit", "validate", "review"]);
    expect(result.acceptedTaskIds).toEqual(["repaired-task"]);
  });
});
