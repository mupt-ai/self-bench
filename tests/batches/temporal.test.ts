import { expect, spyOn, test } from "bun:test";
import { type Client, defaultPayloadConverter } from "@temporalio/client";
import { BATCH_OBSERVE_INTERVAL_MS } from "../../src/contracts/config/execution-limits.js";
import { batchObserver } from "../../src/generation/batches/temporal.js";
import type { GenerationBatch } from "../../src/generation/batches/types.js";
import { candidate, run } from "../support/workflow-fixture.js";

const cost = {
  stage: "author-one-r1",
  state: "estimated" as const,
  sandboxSeconds: 12,
  sandboxUsd: 0.01,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** A Temporal client whose candidate workflows run, one retrying, and answer progress queries. */
function temporal(options: { deadline?: boolean } = {}) {
  const described: string[] = [];
  const queried: string[] = [];
  const client = {
    options: { namespace: "default" },
    connection: {
      withDeadline: async (_deadline: number, action: () => Promise<unknown>) => {
        if (options.deadline) throw new Error("DEADLINE_EXCEEDED");
        return action();
      },
    },
    workflowService: {
      describeWorkflowExecution: async ({ execution }: { execution: { workflowId: string } }) => {
        described.push(execution.workflowId);
        return {
          workflowExecutionInfo: {},
          pendingActivities: [
            {
              state: 1,
              attempt: 3,
              maximumAttempts: 4,
              activityType: { name: "startAuthoringTurn" },
              lastFailure: { message: "the model provider failed; log: gs://bucket/sandbox.log" },
              nextAttemptScheduleTime: { seconds: 1_789_843_794, nanos: 500_000_000 },
              heartbeatDetails: { payloads: [defaultPayloadConverter.toPayload({ cost })] },
            },
          ],
        };
      },
    },
    workflow: {
      getHandle: (workflowId: string) => ({
        query: async () => {
          queried.push(workflowId);
          return { candidateId: "one", taskId: "one", difficulty: "hard", status: "authoring" };
        },
      }),
    },
  } as unknown as Client;
  return { client, described, queried };
}

function authoring(): GenerationBatch {
  return {
    run,
    taskQueue: "generation",
    phase: "authoring",
    shards: [],
    candidates: [
      { workflowId: `${run.runId}/candidate/one`, candidate: candidate("one", 1) },
      {
        workflowId: `${run.runId}/candidate/done`,
        candidate: candidate("done", 2),
        result: {
          progress: { candidateId: "done", taskId: "done", difficulty: "hard", status: "rejected" },
        },
      },
    ],
  };
}

test("a running candidate's progress, cost and current activity come from its workflow", async () => {
  const t = temporal();
  const stored = authoring();
  const { batch, activity } = await batchObserver(t.client)(stored);
  expect(t.described).toEqual([`${run.runId}/candidate/one`]);
  expect(batch.candidates[0]).toMatchObject({ progress: { status: "authoring" }, cost });
  expect(stored.candidates[0]?.progress).toBeUndefined();
  expect(activity).toEqual({
    one: {
      state: "queued",
      activityType: "startAuthoringTurn",
      attempt: 3,
      maximumAttempts: 4,
      lastFailure: "the model provider failed",
      nextAttemptAt: "2026-09-19T18:49:54.500Z",
      cost,
    },
  });
});

test("progress is queried at most once per interval, however often the page polls", async () => {
  const t = temporal();
  const observe = batchObserver(t.client);
  const now = spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    await observe(authoring());
    await observe(authoring());
    expect(t.queried).toHaveLength(1);
    now.mockReturnValue(1_000_000 + BATCH_OBSERVE_INTERVAL_MS);
    expect((await observe(authoring())).batch.candidates[0]?.progress?.status).toBe("authoring");
    expect(t.queried).toHaveLength(2);
    expect(t.described).toHaveLength(3);
  } finally {
    now.mockRestore();
  }
});

test("a finished batch reads nothing, and a Temporal deadline leaves the batch as stored", async () => {
  const t = temporal();
  const complete = { ...authoring(), phase: "complete" as const };
  expect(await batchObserver(t.client)(complete)).toEqual({ batch: complete });
  expect(t.described).toEqual([]);
  const slow = temporal({ deadline: true });
  const { batch, activity } = await batchObserver(slow.client)(authoring());
  expect(batch).toEqual(authoring());
  expect(activity).toEqual({});
});
