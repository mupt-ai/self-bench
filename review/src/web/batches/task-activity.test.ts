import { expect, test } from "bun:test";
import type { BatchStatus } from "../batch-api";
import { activityCounts, taskActivity } from "./task-activity";

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
    activity: { running: "running" },
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
    activity: { interrupted: "running" },
  };

  expect(taskActivity(status, status.tasks?.[0] as NonNullable<BatchStatus["tasks"]>[number])).toBe(
    "stopped",
  );
  expect(taskActivity(status, status.tasks?.[1] as NonNullable<BatchStatus["tasks"]>[number])).toBe(
    "accepted",
  );
});
