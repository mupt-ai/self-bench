import { expect, test } from "bun:test";
import type { TaskItem } from "../api";
import { deleteSelectedTasks } from "./task-deletion";

test("bulk deletion preserves successes and failed identities for retry, with bounded concurrency", async () => {
  const tasks = Array.from(
    { length: 9 },
    (_, index) => ({ runId: `run-${index}`, taskId: "same-name" }) as TaskItem,
  );
  let active = 0;
  let peak = 0;
  const result = await deleteSelectedTasks(tasks, async (task) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    if (task.runId === "run-1") throw new Error("Task generation is still in progress");
    if (task.runId === "run-3") throw new Error("Network unavailable");
  });
  expect(peak).toBeLessThanOrEqual(4);
  expect(result.deleted.size).toBe(7);
  expect(result.deleted.has("run-1:same-name")).toBe(false);
  expect(result.failures.map(({ task }) => task.runId).sort()).toEqual(["run-1", "run-3"]);
  const retried: string[] = [];
  const retry = await deleteSelectedTasks(
    result.failures.map(({ task }) => task),
    async (task) => {
      retried.push(task.runId);
    },
  );
  expect(retried.sort()).toEqual(["run-1", "run-3"]);
  expect(retry.deleted.size).toBe(2);
  expect(retry.failures).toEqual([]);
});
