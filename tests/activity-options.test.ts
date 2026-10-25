import { expect, test } from "bun:test";
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
  expect(record({ attempts: 0 }).retry?.maximumAttempts).toBe(0);
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
