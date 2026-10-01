import { expect, test } from "bun:test";
import { defaultPayloadConverter } from "@temporalio/client";
import { activityDetail, heartbeatCost } from "../../src/generation/batches/activity.js";

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

test("the last failure drops partial-log references and blank messages", () => {
  const failed = (message: string) => activityDetail([{ state: 2, lastFailure: { message } }]);
  expect(failed("sandbox died; partial log: gs://b/x.log")).toEqual({
    state: "running",
    lastFailure: "sandbox died",
  });
  expect(failed("   ")).toEqual({ state: "running" });
});
