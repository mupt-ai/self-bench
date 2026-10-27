import { expect, test } from "bun:test";
import { compileRetryPolicy } from "@temporalio/common";
import { harborQueue, record, task } from "../src/temporal/activity-options.js";

test("a record retries briefly unless told to keep going; heartbeating work waits on cancel", () => {
  expect(record()).toEqual({
    startToCloseTimeout: "1 minute",
    retry: {
      initialInterval: "5 seconds",
      backoffCoefficient: 2,
      maximumInterval: "2 minutes",
      maximumAttempts: 5,
    },
  });
  // Temporal's SDK refuses 0 and drops Infinity, which is its own default of unlimited.
  expect(
    compileRetryPolicy(record({ attempts: Number.POSITIVE_INFINITY }).retry ?? {}),
  ).toMatchObject({
    maximumAttempts: undefined,
  });
  expect(() => compileRetryPolicy({ maximumAttempts: 0 })).toThrow("positive integer");
  expect(record({ final: ["RepeatSpendError"] }).retry?.nonRetryableErrorTypes).toEqual([
    "RepeatSpendError",
  ]);
  expect(task({ timeout: "5 hours", attempts: 4, heartbeat: "5 minutes" })).toMatchObject({
    startToCloseTimeout: "5 hours",
    heartbeatTimeout: "5 minutes",
    cancellationType: "WAIT_CANCELLATION_COMPLETED",
    retry: { maximumAttempts: 4 },
  });
  expect(task({ timeout: "15 minutes" })).not.toHaveProperty("cancellationType");
  expect(harborQueue("selfbench-prod")).toBe("selfbench-prod-harbor");
});
