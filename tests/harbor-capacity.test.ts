import { expect, test } from "bun:test";
import { loadWorkerConfig } from "../src/contracts/config/index.js";
import { harborSlotsForMemory } from "../src/contracts/config/worker-capacity.js";
import { harborTaskQueue } from "../src/temporal/task-queues.js";
import { resolveHarborConcurrency, workerQueues } from "../src/temporal/worker-memory.js";

const GiB = 1024 ** 3;

test("Harbor slots follow worker memory with a floor of two", () => {
  expect(harborSlotsForMemory(2 * GiB)).toBe(2);
  expect(harborSlotsForMemory(8 * GiB)).toBe(10);
  expect(harborSlotsForMemory(16 * GiB)).toBe(10);
  expect(harborSlotsForMemory(32 * GiB)).toBe(10);
});

test("an explicit Harbor concurrency is validated and otherwise left to the worker", () => {
  const base = {
    SELFBENCH_EXECUTION_BACKEND: "modal",
    SELFBENCH_HARBOR_ENVIRONMENT: "modal",
    SELFBENCH_ACTIVITY_CONCURRENCY: "100",
  };
  expect(loadWorkerConfig({ ...base, SELFBENCH_HARBOR_CONCURRENCY: "10" }).harborConcurrency).toBe(
    10,
  );
  expect(loadWorkerConfig(base).harborConcurrency).toBeUndefined();
  expect(() => loadWorkerConfig({ ...base, SELFBENCH_HARBOR_CONCURRENCY: "0" })).toThrow();
  expect(() => loadWorkerConfig({ ...base, SELFBENCH_HARBOR_CONCURRENCY: "11" })).toThrow();
});

test("the resolved Harbor concurrency keeps the hard cap for direct callers", () => {
  expect(resolveHarborConcurrency(100)).toBe(10);
});

test("the Harbor queue is derived from the worker queue", () => {
  expect(harborTaskQueue("selfbench-prod")).toBe("selfbench-prod-harbor");
});

test("a Harbor-only replica is sized to the compose memory limit and must be requested", () => {
  // infra/runtime/compose.yaml gives each harbor-worker replica 5 GiB.
  expect(harborSlotsForMemory(5 * GiB)).toBe(10);
  expect(workerQueues({})).toBe("all");
  expect(workerQueues({ SELFBENCH_WORKER_QUEUES: "" })).toBe("all");
  expect(workerQueues({ SELFBENCH_WORKER_QUEUES: "harbor" })).toBe("harbor");
  expect(() => workerQueues({ SELFBENCH_WORKER_QUEUES: "generation" })).toThrow();
});
