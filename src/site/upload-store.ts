import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { repos, tasks } from "../db/schema.js";
import type { TaskRecord, TaskUpsert } from "./task-store.js";
import type { UploadTask } from "./upload-validate.js";

export interface UploadPreviewTask {
  taskId: string;
  digest: string;
  errors: string[];
  conflicts: string[];
}
export function uploadPreview(
  incoming: UploadTask[],
  existing: Pick<TaskRecord, "taskId" | "definition">[],
): UploadPreviewTask[] {
  const ids = new Set(existing.map((row) => row.taskId));
  const digests = new Set(existing.map((row) => row.definition?.uploadDigest).filter(Boolean));
  return incoming.map((task) => {
    const conflicts: string[] = [];
    if (ids.has(task.taskId)) conflicts.push("Task ID already exists");
    if (task.digest && digests.has(task.digest))
      conflicts.push("Identical task content already exists");
    // Reserve all seen identities, including malformed entries: never guess which duplicate to keep.
    ids.add(task.taskId);
    if (task.digest) digests.add(task.digest);
    return { taskId: task.taskId, digest: task.digest, errors: task.errors, conflicts };
  });
}

/** Serialize imports for one repo, then recheck conflicts under the lock; no review overwrites. */
export async function insertUploads(
  db: Database,
  repoId: number,
  incoming: UploadTask[],
  rows: TaskUpsert[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [repo] = await tx
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.id, repoId))
      .for("update");
    if (!repo) return false;
    const existing = await tx
      .select({ taskId: tasks.taskId, definition: tasks.definition })
      .from(tasks)
      .where(eq(tasks.repoId, repoId));
    if (
      uploadPreview(
        incoming,
        existing.map((row) => ({
          taskId: row.taskId,
          ...(row.definition ? { definition: row.definition } : {}),
        })),
      ).some((task) => task.conflicts.length || task.errors.length)
    )
      return false;
    await tx.insert(tasks).values(rows);
    return true;
  });
}
