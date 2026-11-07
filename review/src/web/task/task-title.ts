/**
 * Present source PRs, or a scenario's title, without exposing discovery shard identifiers. A
 * variant adds its label, since it shares the task it changes' PR or title.
 */
export function taskTitle(task: {
  taskId?: string;
  sourcePr?: number;
  title?: string;
  variant?: string;
}): string {
  const pr = task.sourcePr ?? task.taskId?.match(/-pr-(\d+)$/)?.[1];
  const base = task.title ?? (pr ? `PR #${pr}` : "Task");
  return task.variant ? `${base} · ${task.variant}` : base;
}
