import { expect, test } from "bun:test";
import { advanceBatch } from "../../src/batches/advance.js";
import { batchStatus } from "../../src/batches/status.js";
import type { BatchExecutions } from "../../src/batches/temporal.js";
import type { GenerationBatch } from "../../src/batches/types.js";
import { MAX_CONCURRENT_CANDIDATE_WORKFLOWS } from "../../src/execution-limits.js";
import { artifact, candidate, run } from "../support/workflow-fixture.js";

function batch(): GenerationBatch {
  return {
    run,
    taskQueue: "test",
    phase: "discovering",
    candidates: [],
    shards: [0, 1].map((index) => ({
      workflowId: `run/discovery/${index}`,
      dispatchAttempted: true,
      input: {
        run,
        wave: 0,
        shardIndex: index,
        shardCount: 2,
        partitioned: true,
        targetCounts: run.candidateCounts,
        excludedSourcePrs: [],
      },
    })),
  };
}
test("discovery ends independently; durable candidate plan precedes dispatch and results aggregate", async () => {
  const state = batch();
  const calls: string[] = [];
  const executions: BatchExecutions = {
    shard: async (id) => {
      calls.push(id);
      return {
        state: "completed",
        result: { report: artifact, candidates: [candidate("one", 1)] },
      };
    },
    candidate: async (id) => {
      calls.push(id);
      return {
        state: "completed",
        result: {
          progress: { candidateId: "one", taskId: "one", difficulty: "hard", status: "rejected" },
        },
      };
    },
    cancel: async () => true,
  };
  await advanceBatch(state, executions);
  expect(state.phase).toBe("discovering");
  await advanceBatch(state, executions);
  expect(state.phase).toBe("authoring");
  expect(state.candidates).toHaveLength(1);
  expect(calls).toHaveLength(2);
  expect(batchStatus(state).tasks[0]?.status).toBe("queued");
  await advanceBatch(state, executions); // Persist dispatch intent.
  await advanceBatch(state, executions);
  expect(state.phase).toBe("exporting");
  expect(batchStatus(state).rejected).toBe(1);
  await advanceBatch(state, executions);
  expect(calls).toHaveLength(3);
});
test("live shard costs are retained only until settled accounting takes over", async () => {
  const state = batch();
  const first = state.shards[0];
  if (!first) throw new Error("missing shard fixture");
  state.shards = [first];
  let running = true;
  const executions: BatchExecutions = {
    shard: async () =>
      running
        ? {
            state: "running",
            cost: {
              stage: "discover-0-0",
              state: "estimated",
              sandboxSeconds: 5,
              sandboxUsd: 0.001,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : { state: "completed", result: { report: artifact, candidates: [] } },
    candidate: async () => {
      throw new Error("must not start");
    },
    cancel: async () => true,
  };

  await advanceBatch(state, executions);
  expect(state.shards[0]?.cost?.sandboxSeconds).toBe(5);
  running = false;
  await advanceBatch(state, executions);
  expect(state.shards[0]?.cost).toBeUndefined();
});

test("an independently cancelled candidate keeps an explicit cancellation terminal", async () => {
  const state = batch();
  state.phase = "authoring";
  state.shards = [];
  state.candidates = [
    {
      workflowId: "run/candidate/one",
      dispatchAttempted: true,
      candidate: candidate("one", 1),
    },
  ];
  const executions: BatchExecutions = {
    shard: async () => {
      throw new Error("must not start");
    },
    candidate: async () => ({ state: "cancelled" }),
    cancel: async () => true,
  };

  await advanceBatch(state, executions);
  expect(state.candidates[0]).toMatchObject({
    cancelled: true,
    error: "Generation cancelled.",
  });
  expect(batchStatus(state).tasks[0]).toMatchObject({
    status: "infrastructure_failed",
    reason: "Generation cancelled.",
  });
});

test("candidate dispatch respects the shared workflow concurrency limit", async () => {
  const state = batch();
  state.phase = "authoring";
  state.shards = [];
  state.candidates = Array.from({ length: MAX_CONCURRENT_CANDIDATE_WORKFLOWS + 1 }, (_, index) => ({
    workflowId: `run/candidate/${index}`,
    ...(index < MAX_CONCURRENT_CANDIDATE_WORKFLOWS ? { dispatchAttempted: true } : {}),
    candidate: candidate(`candidate-${index}`, index + 1),
  }));
  let observed = 0;
  const executions: BatchExecutions = {
    shard: async () => {
      throw Error("must not start");
    },
    candidate: async () => {
      observed += 1;
      return { state: "running" };
    },
    cancel: async () => true,
  };

  await advanceBatch(state, executions);

  expect(observed).toBe(1);
  expect(state.candidates[MAX_CONCURRENT_CANDIDATE_WORKFLOWS]?.dispatchAttempted).toBeUndefined();
});

test("batch cancellation preserves candidates that already finished", async () => {
  const state = batch();
  state.phase = "cancelling";
  state.shards = [];
  state.candidates = [
    {
      workflowId: "run/candidate/done",
      dispatchAttempted: true,
      candidate: candidate("done", 1),
      result: {
        progress: {
          candidateId: "done",
          taskId: "finished-task",
          difficulty: "hard",
          status: "accepted",
        },
      },
    },
    {
      workflowId: "run/candidate/pending",
      dispatchAttempted: true,
      candidate: candidate("pending", 2),
    },
  ];
  const cancelled: string[] = [];
  const executions: BatchExecutions = {
    shard: async () => {
      throw Error("must not start");
    },
    candidate: async () => {
      throw Error("must not start");
    },
    cancel: async (workflowId) => {
      cancelled.push(workflowId);
      return true;
    },
  };

  await advanceBatch(state, executions);

  expect(cancelled).toEqual(["run/candidate/pending"]);
  expect(String(state.phase)).toBe("cancelled");
  expect(state.candidates[0]?.cancelled).toBeUndefined();
  expect(batchStatus(state)).toMatchObject({
    accepted: 1,
    tasks: [
      { candidateId: "done", taskId: "finished-task", status: "accepted" },
      { candidateId: "pending", status: "infrastructure_failed" },
    ],
  });
});

test("cancellation never starts work and stays pending until independent executions settle", async () => {
  const state = batch();
  state.phase = "cancelling";
  let settled = false;
  const executions: BatchExecutions = {
    shard: async () => {
      throw Error("must not start");
    },
    candidate: async () => {
      throw Error("must not start");
    },
    cancel: async () => settled,
  };
  await advanceBatch(state, executions);
  expect(state.phase).toBe("cancelling");
  settled = true;
  await advanceBatch(state, executions);
  await advanceBatch(state, executions);
  expect(String(state.phase)).toBe("cancelled");
});
