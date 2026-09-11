/** Present source PRs without exposing discovery shard identifiers. */
export function taskTitle(task: { taskId: string; sourcePr?: number }): string {
  const pr = task.sourcePr ?? task.taskId.match(/-pr-(\d+)$/)?.[1];
  return pr ? `PR #${pr}` : "Task";
}
