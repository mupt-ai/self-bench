import { expect, test } from "bun:test";
import type { TaskItem } from "../api";
import { sameTask } from "../pages/TaskPage";
import { comparisonActive } from "./ComparisonPage";

const run = (status: string) => ({ status }) as never;

test("a comparison page polls while any run has yet to finish", () => {
  expect(comparisonActive({ runs: [run("completed"), run("failed")] })).toBe(false);
  expect(comparisonActive({ runs: [] })).toBe(false);
  for (const status of ["pending", "queued", "running"])
    expect(comparisonActive({ runs: [run("completed"), run(status)] })).toBe(true);
});

test("a task read again is the same task unless something but its sync time changed", () => {
  const task = { runId: "batch-1", taskId: "t", state: "in_progress", syncedAt: "1" } as TaskItem;
  expect(sameTask(task, { ...task, syncedAt: "2" })).toBe(true);
  expect(sameTask(task, { ...task, state: "accepted" } as TaskItem)).toBe(false);
  expect(sameTask(task, { ...task, round: 2 })).toBe(false);
});
