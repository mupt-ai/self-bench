import { expect, test } from "bun:test";
import type { TaskItem } from "../api";
import { taskSourceKey } from "../task/site-source";
import { comparisonActive } from "./ComparisonPage";

const run = (status: string) => ({ status }) as never;

test("a comparison page polls while any run has yet to finish", () => {
  expect(comparisonActive({ runs: [run("completed"), run("failed")] })).toBe(false);
  expect(comparisonActive({ runs: [] })).toBe(false);
  for (const status of ["pending", "queued", "running"])
    expect(comparisonActive({ runs: [run("completed"), run(status)] })).toBe(true);
});

test("a task's source changes with its progress, not with a poll's fresh cost or sync time", () => {
  const task = {
    runId: "batch-1",
    taskId: "t",
    candidateId: "c",
    difficulty: "easy",
    stage: "authoring",
    pipelineStatus: "in_progress",
    state: "in_progress",
    syncedAt: "1",
    cost: { updatedAt: "1", totalUsd: 0.1 },
  } as unknown as TaskItem;
  const key = taskSourceKey(task);
  expect(taskSourceKey({ ...task, syncedAt: "2" })).toBe(key);
  const spent = { ...task, cost: { updatedAt: "2", totalUsd: 0.4 } } as unknown as TaskItem;
  expect(taskSourceKey(spent)).toBe(key);
  expect(taskSourceKey({ ...task, stage: "review" })).not.toBe(key);
  expect(taskSourceKey({ ...task, pipelineStatus: "accepted" })).not.toBe(key);
});
