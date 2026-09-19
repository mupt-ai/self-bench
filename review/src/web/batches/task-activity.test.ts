import { expect, test } from "bun:test";
import type { BatchStatus } from "../batch-api";
import { activityCounts, repeatedFailure, retryDetail, taskActivity } from "./task-activity";

const task = (
  candidateId: string,
  status: NonNullable<BatchStatus["tasks"]>[number]["status"],
) => ({
  taskId: `task-${candidateId}`,
  candidateId,
  difficulty: "easy" as const,
  status,
});

test("distinguishes live execution from workflow stage", () => {
  const status: BatchStatus = {
    runId: "batch-one",
    phase: "authoring",
    tasks: [task("running", "verifying"), task("waiting", "queued"), task("unknown", "authoring")],
    activity: { running: { state: "running" } },
  };

  expect(taskActivity(status, status.tasks?.[0] as NonNullable<BatchStatus["tasks"]>[number])).toBe(
    "running",
  );
  expect(taskActivity(status, status.tasks?.[1] as NonNullable<BatchStatus["tasks"]>[number])).toBe(
    "queued",
  );
  expect(taskActivity(status, status.tasks?.[2] as NonNullable<BatchStatus["tasks"]>[number])).toBe(
    "unknown",
  );
  expect(activityCounts(status)).toMatchObject({ running: 1, queued: 1, unknown: 1 });
});

test("terminal batches report unfinished tasks as stopped", () => {
  const status: BatchStatus = {
    runId: "batch-one",
    phase: "cancelled",
    tasks: [task("interrupted", "reviewing"), task("verified", "accepted")],
    activity: { interrupted: { state: "running" } },
  };

  expect(taskActivity(status, status.tasks?.[0] as NonNullable<BatchStatus["tasks"]>[number])).toBe(
    "stopped",
  );
  expect(taskActivity(status, status.tasks?.[1] as NonNullable<BatchStatus["tasks"]>[number])).toBe(
    "accepted",
  );
});

test("a retrying candidate shows its attempt and last failure", () => {
  const status: BatchStatus = {
    runId: "batch-one",
    phase: "authoring",
    tasks: [task("retrying", "authoring"), task("fresh", "authoring")],
    activity: {
      retrying: { state: "queued", attempt: 3, maximumAttempts: 4, lastFailure: "quota reached" },
      fresh: { state: "running", attempt: 1 },
    },
  };
  const [retrying, fresh] = status.tasks as NonNullable<BatchStatus["tasks"]>;
  expect(retryDetail(status, retrying as never)).toBe("Attempt 3 of 4 · quota reached");
  expect(retryDetail(status, fresh as never)).toBeUndefined();
});

test("a failure shared by enough in-flight candidates is reported once for the batch", () => {
  const quota = { state: "queued" as const, attempt: 2, lastFailure: "quota reached" };
  const status: BatchStatus = {
    runId: "batch-one",
    phase: "authoring",
    tasks: [
      task("a", "authoring"),
      task("b", "verifying"),
      task("c", "reviewing"),
      task("d", "authoring"),
      { ...task("done", "infrastructure_failed"), reason: "quota reached" },
    ],
    activity: { a: quota, b: quota, c: quota, d: { state: "running", lastFailure: "other" } },
  };
  expect(repeatedFailure(status)).toEqual({ count: 3, failure: "quota reached" });
  expect(repeatedFailure({ ...status, activity: { a: quota, b: quota } })).toBeUndefined();
  expect(repeatedFailure({ ...status, phase: "complete" })).toBeUndefined();
});
