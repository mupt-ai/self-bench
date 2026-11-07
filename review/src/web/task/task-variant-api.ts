import type { GenerationSettings } from "../../../../src/generation/settings/settings";
import { repoPath, requestJson, type TaskItem } from "../api";

/** What a variant changes in an accepted task's environment (generation/tasks/variant.ts). */
export interface VariantInput {
  label: string;
  packages: { name: string; spec: string; directory: string }[];
  files: { path: string; mode: "replace" | "append"; content: string }[];
}

/** Starts a variant: the task with only its environment changed, checked once, never re-authored. */
export async function createTaskVariant(
  org: string,
  fullName: string,
  task: { runId: string; taskId: string },
  variant: VariantInput,
  generation?: GenerationSettings,
): Promise<TaskItem> {
  const body = await requestJson<{ task: TaskItem }>(
    `${repoPath(org, fullName)}/tasks/${encodeURIComponent(task.runId)}/${encodeURIComponent(task.taskId)}/variants`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variant, ...(generation ? { generation } : {}) }),
    },
  );
  return body.task;
}
