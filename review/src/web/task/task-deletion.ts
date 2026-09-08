import type { TaskItem } from "../api";

export const taskKey = (task: Pick<TaskItem, "runId" | "taskId">) => `${task.runId}:${task.taskId}`;

/** Bound concurrency and preserve individual outcomes so failed bulk selections can be retried. */
export async function deleteSelectedTasks(
  tasks: readonly TaskItem[],
  remove: (task: TaskItem) => Promise<void>,
) {
  const deleted = new Set<string>();
  const failures: { task: TaskItem; error: string }[] = [];
  const queue = [...tasks];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        try {
          await remove(task);
          deleted.add(taskKey(task));
        } catch (cause) {
          failures.push({
            task,
            error: cause instanceof Error ? cause.message : "Deletion failed",
          });
        }
      }
    }),
  );
  return { deleted, failures };
}
