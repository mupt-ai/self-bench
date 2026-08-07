import { expect, test } from "bun:test";
import { loadGuardedTaskDetail } from "./detail-loader";
import type { TaskDetail } from "./types";

test("a late detail response cannot overwrite a newly selected task", async () => {
  const controller = new AbortController();
  const detail = { summary: { task_id: "task-a" } } as TaskDetail;
  let selected = "task-a";
  const committed: TaskDetail[] = [];
  const pending = loadGuardedTaskDetail(
    "task-a",
    controller.signal,
    (taskId) => taskId === selected,
    async () => detail,
    (value) => committed.push(value),
  );
  selected = "task-b";
  await pending;
  expect(committed).toEqual([]);
});
