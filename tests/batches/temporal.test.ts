import { expect, test } from "bun:test";
import { type Client, WorkflowNotFoundError } from "@temporalio/client";
import { batchExecutions } from "../../src/batches/temporal.js";
import { artifact, candidate, run } from "../support/workflow-fixture.js";

function fixture() {
  let exists = false;
  let state = "RUNNING";
  let starts = 0;
  let ambiguous = false;
  let seen: unknown;
  const handle = {
    describe: async () => {
      if (!exists) throw new WorkflowNotFoundError("missing", "batch/discovery/0", undefined);
      return {
        type: "selfBenchDiscoveryShardWorkflow",
        runId: "execution",
        status: { name: state },
      };
    },
    result: async () => ({ candidates: [candidate("one", 1)], report: artifact }),
    cancel: async () => {
      state = "CANCELLED";
    },
  };
  const client = {
    connection: {
      withDeadline: async (_deadline: number, action: () => Promise<unknown>) => action(),
    },
    workflow: {
      getHandle: () => handle,
      start: async (type: string, options: unknown) => {
        starts++;
        exists = true;
        seen = { type, options };
        if (ambiguous) throw Error("response lost");
      },
    },
  } as unknown as Client;
  return {
    client,
    starts: () => starts,
    seen: () => seen,
    complete: () => {
      state = "COMPLETED";
    },
    ambiguous: () => {
      ambiguous = true;
    },
  };
}
const input = {
  run,
  wave: 0,
  shardIndex: 0,
  shardCount: 1,
  targetCounts: run.candidateCounts,
  excludedSourcePrs: [],
  partitioned: true,
};
test("top-level discovery start is restart safe after lost start response", async () => {
  const f = fixture();
  f.ambiguous();
  const execution = batchExecutions(f.client);
  await expect(execution.shard("batch/discovery/0", input, "queue")).rejects.toThrow(
    "response lost",
  );
  const restarted = batchExecutions(f.client);
  expect((await restarted.shard("batch/discovery/0", input, "queue")).state).toBe("running");
  expect(f.starts()).toBe(1);
  expect(f.seen()).toEqual({
    type: "selfBenchDiscoveryShardWorkflow",
    options: expect.objectContaining({
      workflowId: "batch/discovery/0",
      taskQueue: "queue",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    }),
  });
  f.complete();
  expect((await restarted.shard("batch/discovery/0", input, "queue")).state).toBe("completed");
  expect(f.starts()).toBe(1);
});
test("cancel of an ambiguously dispatched ID stays unresolved and never creates a workflow", async () => {
  const f = fixture();
  expect(await batchExecutions(f.client).cancel("batch/discovery/0")).toBe(false);
  expect(f.starts()).toBe(0);
});
