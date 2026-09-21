import { expect, test } from "bun:test";
import { loadWorkerConfig } from "../src/config.js";
import { harborTaskQueue } from "../src/temporal/task-queues.js";
import { harborSlotsForMemory } from "../src/worker-capacity.js";

const GiB = 1024 ** 3;

test("Harbor slots follow worker memory with a floor of two", () => {
  expect(harborSlotsForMemory(2 * GiB)).toBe(2);
  expect(harborSlotsForMemory(8 * GiB)).toBe(23);
  expect(harborSlotsForMemory(16 * GiB)).toBe(55);
  expect(harborSlotsForMemory(32 * GiB)).toBe(119);
});

test("an explicit Harbor concurrency is validated and otherwise left to the worker", () => {
  const base = {
    SELFBENCH_EXECUTION_BACKEND: "modal",
    SELFBENCH_HARBOR_ENVIRONMENT: "modal",
    SELFBENCH_ACTIVITY_CONCURRENCY: "100",
  };
  expect(loadWorkerConfig({ ...base, SELFBENCH_HARBOR_CONCURRENCY: "16" }).harborConcurrency).toBe(
    16,
  );
  expect(loadWorkerConfig(base).harborConcurrency).toBeUndefined();
  expect(() => loadWorkerConfig({ ...base, SELFBENCH_HARBOR_CONCURRENCY: "0" })).toThrow();
});

test("the Harbor queue is derived from the worker queue", () => {
  expect(harborTaskQueue("selfbench-prod")).toBe("selfbench-prod-harbor");
});
