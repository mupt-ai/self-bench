import { and, inArray, isNotNull } from "drizzle-orm";
import { createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { openDatabase } from "../src/db/client.js";
import { tasks } from "../src/db/schema.js";
import { createVault } from "../src/db/vault.js";
import { imageAction, taskImageReconciler } from "../src/generation/tasks/task-images.js";
import { redactSecrets } from "../src/lib/redact.js";

/**
 * Brings existing tasks' exported images in line with their human reviews, as the worker now does
 * after each review: approved tasks get their verified images exported and delivered by digest,
 * rejected or deleted ones lose images no comparison or release pins.
 *
 *   node dist/maintenance/backfill-execution-bundles.js <repoId>... [--row=<taskRowId>]... [--apply]
 *
 * As a Cloud Run job with several tasks, each takes every CLOUD_RUN_TASK_COUNT-th task that needs
 * a change, so exports run in parallel, each on its own instance.
 */
export async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const rowIds = args.filter((arg) => arg.startsWith("--row=")).map((arg) => arg.slice(6));
  const repos = args.filter((arg) => !arg.startsWith("--"));
  if (
    !repos.length ||
    [...repos, ...rowIds].some((id) => !/^[1-9]\d*$/.test(id)) ||
    args.some((arg) => arg.startsWith("--") && arg !== "--apply" && !arg.startsWith("--row="))
  )
    throw new Error(
      "Usage: backfill-execution-bundles.js <repoId>... [--row=<taskRowId>]... [--apply]",
    );
  const config = loadConfig();
  if (!config.taskImages?.repository) throw new Error("SELFBENCH_TASK_IMAGE_REPOSITORY is required");
  const url = process.env.SELFBENCH_DATABASE_URL;
  const key = process.env.SELFBENCH_EVAL_CREDENTIAL_KEY;
  if (!url || !key) throw new Error("Database and credential encryption configuration required");
  const shard = Number(process.env.CLOUD_RUN_TASK_INDEX ?? 0);
  const shards = Number(process.env.CLOUD_RUN_TASK_COUNT ?? 1);
  const database = await openDatabase(url, { light: true });
  const reconcile = taskImageReconciler({
    db: database.db,
    vault: createVault(database.db, key),
    store: createArtifactStore(config.artifact),
    repository: config.taskImages.repository,
  });
  try {
    const rows = await database.db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.repoId, repos.map(Number)),
          ...(rowIds.length ? [inArray(tasks.id, rowIds.map(Number))] : []),
          isNotNull(tasks.bundleKey),
          isNotNull(tasks.images),
        ),
      )
      .orderBy(tasks.id);
    // Shard only the tasks with something to do, so each instance gets a fair share of the work.
    const work = rows.filter((task) => imageAction(task) !== undefined);
    for (const [index, task] of work.entries()) {
      if (index % shards !== shard) continue;
      const ids = { repoId: task.repoId, rowId: task.id, taskId: task.taskId, runId: task.runId };
      try {
        const result = await reconcile(task, apply);
        if (result.status !== "skipped") console.log(JSON.stringify({ ...ids, ...result }));
      } catch (error) {
        console.error(JSON.stringify({ ...ids, status: "failed", reason: failureReason(error) }));
        process.exitCode = 1;
      }
    }
  } finally {
    await database.close();
  }
}

/** The innermost cause, with credentials redacted and long provider output cut to its end. */
function failureReason(error: unknown): string {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  const message = current instanceof Error ? current.message : String(current);
  return redactSecrets(message).slice(-1500);
}
