import type { LocalTaskSummary, TaskFiles } from "../types";
import type { ApiClient, TaskSource } from "./types";

export async function openLocalSource(api: ApiClient, root: string): Promise<TaskSource> {
  const tasks = await api.json<LocalTaskSummary[]>("/v1/local/tasks");
  return {
    kind: "local",
    label: root,
    summary: `${tasks.length} task director${tasks.length === 1 ? "y" : "ies"}`,
    rows: tasks.map((task) => ({
      id: task.taskId,
      name: task.name ?? task.taskId,
      path: task.path,
      fileCount: task.fileCount,
      ...(task.difficulty ? { difficulty: task.difficulty } : {}),
    })),
    loadFiles: (id) => api.json<TaskFiles>(`/v1/local/task?id=${encodeURIComponent(id)}`),
  };
}
