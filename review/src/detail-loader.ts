import type { TaskDetail } from "./types";

export async function loadGuardedTaskDetail(
  taskId: string,
  signal: AbortSignal,
  isSelected: (taskId: string) => boolean,
  load: (taskId: string, signal: AbortSignal) => Promise<TaskDetail>,
  commit: (detail: TaskDetail) => void,
): Promise<void> {
  const detail = await load(taskId, signal);
  if (!signal.aborted && isSelected(taskId)) {
    commit(detail);
  }
}
