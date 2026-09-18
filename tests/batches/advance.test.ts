import { expect, test } from "bun:test";
import { advanceBatch } from "../../src/batches/advance.js";
import { batchStatus } from "../../src/batches/status.js";
import type { BatchExecutions } from "../../src/batches/temporal.js";
import type { GenerationBatch } from "../../src/batches/types.js";
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
