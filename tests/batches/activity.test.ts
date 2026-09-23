import { expect, test } from "bun:test";
import { type Client, defaultPayloadConverter } from "@temporalio/client";
import {
  activityDetail,
  heartbeatCost,
  liveBatchStatus,
  normalizeFailure,
  overlayCandidateActivity,
} from "../../src/generation/batches/activity.js";

test("heartbeat costs decode valid Temporal payloads and reject unsafe values", () => {
  const payload = defaultPayloadConverter.toPayload({
    detail: "authoring",
    cost: {
      stage: "author-candidate-r1",
      state: "partial",
      sandboxSeconds: 12,
      modelUsd: 0.25,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  expect(heartbeatCost(payload)).toEqual({
    stage: "author-candidate-r1",
    state: "partial",
    sandboxSeconds: 12,
    modelUsd: 0.25,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(
    heartbeatCost(
      defaultPayloadConverter.toPayload({
        cost: {
          state: "estimated",
          sandboxSeconds: Number.NaN,
          sandboxUsd: -1,
          updatedAt: "not-a-date",
        },
      }),
    ),
  ).toBeUndefined();
  expect(heartbeatCost({ metadata: {}, data: new Uint8Array([1, 2, 3]) })).toBeUndefined();
});

test("batch progress distinguishes running, queued and unavailable activity state", async () => {
  const client = {
    options: { namespace: "default" },
    connection: {
      withDeadline: async (_deadline: number, action: () => Promise<unknown>) => action(),
    },
    workflow: {
      getHandle: () => ({
        query: async () => ({
          runId: "batch-one",
          phase: "authoring",
          tasks: ["active", "waiting", "missing"].map((candidateId) => ({
            candidateId,
            status: "authoring",
          })),
        }),
        describe: async () => ({ status: { name: "RUNNING" } }),
      }),
    },
    workflowService: {
      describeWorkflowExecution: async ({ execution }: { execution: { workflowId: string } }) => {
        if (execution.workflowId.endsWith("missing")) throw new Error("unavailable");
        return { pendingActivities: [{ state: execution.workflowId.endsWith("active") ? 2 : 1 }] };
      },
    },
  } as unknown as Client;
  const status = await liveBatchStatus(client, "batch-one");
  expect(status.activity).toEqual({
    active: { state: "running" },
    waiting: { state: "queued" },
    missing: { state: "unknown" },
  });
  expect(status.tasks).toHaveLength(3);
});

test("a persisted batch status gains the same activity overlay as a live one", async () => {
  const described: string[] = [];
  const client = {
    options: { namespace: "default" },
    connection: {
      withDeadline: async (_deadline: number, action: () => Promise<unknown>) => action(),
    },
    workflowService: {
      describeWorkflowExecution: async ({ execution }: { execution: { workflowId: string } }) => {
        described.push(execution.workflowId);
        return {
          pendingActivities: [
            {
              state: 1,
              attempt: 3,
              maximumAttempts: 4,
              activityType: { name: "runAuthoringRound" },
              lastFailure: {
                message:
                  "authoring round 1: the model provider failed mid-session (Codex error: The usage limit has been reached) before a terminal tool call; log: gs://bucket/runs/batch-one/authoring/one/round-1/attempt-2/sandbox.log",
              },
              nextAttemptScheduleTime: { seconds: 1_789_843_794, nanos: 500_000_000 },
            },
          ],
        };
      },
    },
  } as unknown as Client;
  const status = await overlayCandidateActivity(client, {
    runId: "batch-one",
    phase: "authoring",
    tasks: [
      { candidateId: "one", taskId: "one", difficulty: "easy", status: "authoring" },
      { candidateId: "done", taskId: "done", difficulty: "easy", status: "accepted" },
    ],
  });
  expect(described).toEqual(["batch-one/candidate/one"]);
  expect(status.activity).toEqual({
    one: {
      state: "queued",
      activityType: "runAuthoringRound",
      attempt: 3,
      maximumAttempts: 4,
      lastFailure:
        "authoring round 1: the model provider failed mid-session (Codex error: The usage limit has been reached) before a terminal tool call",
      nextAttemptAt: "2026-09-19T18:49:54.500Z",
    },
  });
});

test("terminal batches are returned without reading candidate workflows", async () => {
  const client = {
    workflowService: {
      describeWorkflowExecution: async () => {
        throw new Error("must not describe");
      },
    },
  } as unknown as Client;
  const status = { runId: "batch-one", phase: "complete" as const, tasks: [] };
  expect(await overlayCandidateActivity(client, status)).toBe(status);
});

test("the started attempt wins over a scheduled one and Long timestamps convert", () => {
  const detail = activityDetail([
    { state: 1, attempt: 2 },
    {
      state: 2,
      attempt: 1,
      nextAttemptScheduleTime: { seconds: { toNumber: () => 1_700_000_000 }, nanos: 0 },
    },
  ]);
  expect(detail).toEqual({
    state: "running",
    attempt: 1,
    nextAttemptAt: "2023-11-14T22:13:20.000Z",
  });
  expect(activityDetail([])).toEqual({ state: "unknown" });
});

test("failure normalization removes artifact references and blank messages", () => {
  expect(normalizeFailure("sandbox died; partial log: gs://b/x.log")).toBe("sandbox died");
  expect(normalizeFailure("   ")).toBeUndefined();
  expect(normalizeFailure(undefined)).toBeUndefined();
});

test("a Temporal deadline returns unknown activity instead of hanging the poll", async () => {
  const client = {
    options: { namespace: "default" },
    connection: {
      withDeadline: async () => {
        throw new Error("DEADLINE_EXCEEDED");
      },
    },
    workflowService: {
      describeWorkflowExecution: async () => await new Promise(() => undefined),
    },
  } as unknown as Client;
  const status = await overlayCandidateActivity(client, {
    runId: "batch-one",
    phase: "authoring",
    tasks: [{ candidateId: "one", taskId: "one", difficulty: "easy", status: "authoring" }],
  });
  expect(status.activity).toEqual({ one: { state: "unknown" } });
});
