import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { tasks } from "../db/schema.js";

export class TaskNotFoundError extends Error {
  constructor() {
    super("task not found");
  }
}

/** Keep status validation and tombstoning under the same row lock as ingestion/progress. */
export function tombstoneTask(
  db: Database,
  repoId: number,
  runId: string,
  taskId: string,
  now: () => Date,
): Promise<"deleted" | "active" | "missing"> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.repoId, repoId), eq(tasks.runId, runId), eq(tasks.taskId, taskId)))
      .for("update");
    if (!task) return "missing";
    if (task.deletedAt) return "deleted";
    if (task.pipelineStatus === "in_progress") return "active";
    await tx
      .update(tasks)
      .set({ deletedAt: now() })
      .where(and(eq(tasks.id, task.id), eq(tasks.repoId, repoId)));
    return "deleted";
  });
}
