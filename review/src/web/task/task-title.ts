/** Present source PRs, or a scenario's title, without exposing discovery shard identifiers. */
export function taskTitle(task: { taskId?: string; sourcePr?: number; title?: string }): string {
  if (task.title) return task.title;
  const pr = task.sourcePr ?? task.taskId?.match(/-pr-(\d+)$/)?.[1];
  return pr ? `PR #${pr}` : "Task";
}
