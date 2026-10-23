/**
 * Re-verifies accepted tasks that predate image recording, so they can move onto execution
 * bundles: each task's compiled bundle runs the Harbor gates again on its run's own verification
 * account, the images that pass are recorded, and approved tasks are exported.
 *
 *   node dist/maintenance/reverify-task-images.js <repoId>... [--row=<taskRowId>]... [--apply]
 *
 * As a Cloud Run job with several tasks, each takes every CLOUD_RUN_TASK_COUNT-th row.
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { openDatabase } from "../src/db/client.js";
import { tasks } from "../src/db/schema.js";
import { createVault } from "../src/db/vault.js";
import { exportEnvironment, verificationProvider } from "../src/generation/tasks/task-image-credentials.js";
import { reverifyTaskImages } from "../src/generation/tasks/task-image-reverify.js";
import { taskImageReconciler, taskImageRows } from "../src/generation/tasks/task-images.js";

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
    throw new Error("Usage: reverify-task-images.js <repoId>... [--row=<taskRowId>]... [--apply]");
  const config = loadConfig();
  if (!config.taskImages?.repository) throw new Error("SELFBENCH_TASK_IMAGE_REPOSITORY is required");
  const url = process.env.SELFBENCH_DATABASE_URL;
  const key = process.env.SELFBENCH_EVAL_CREDENTIAL_KEY;
  if (!url || !key) throw new Error("Database and credential encryption configuration required");
  const shard = Number(process.env.CLOUD_RUN_TASK_INDEX ?? 0);
  const shards = Number(process.env.CLOUD_RUN_TASK_COUNT ?? 1);
  const database = await openDatabase(url, { light: true });
  const vault = createVault(database.db, key);
  const store = createArtifactStore(config.artifact);
  const rows = taskImageRows(database.db);
  const reconcile = taskImageReconciler({
    db: database.db,
    vault,
    store,
    repository: config.taskImages.repository,
  });
  try {
    const candidates = await database.db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.repoId, repos.map(Number)),
          ...(rowIds.length ? [inArray(tasks.id, rowIds.map(Number))] : []),
          eq(tasks.pipelineStatus, "accepted"),
          isNull(tasks.deletedAt),
          isNull(tasks.images),
          isNotNull(tasks.bundleKey),
        ),
      )
      .orderBy(tasks.id);
    for (const [index, task] of candidates.entries()) {
      if (index % shards !== shard) continue;
      const ids = { repoId: task.repoId, rowId: task.id, taskId: task.taskId, runId: task.runId };
      try {
        const result = await reverifyTaskImages(store, task, {
          apply,
          provider: () => verificationProvider(vault, task.runId),
          environment: (provider) => exportEnvironment(vault, task.runId, provider, process.env),
          save: (images) => rows.save(task, task.bundleKey ?? "", images),
          export: async (images) => await reconcile({ ...task, images }, true),
          signal: new AbortController().signal,
        });
        console.log(JSON.stringify({ ...ids, ...result }));
        if (result.status === "failed") process.exitCode = 1;
      } catch (error) {
        // Provider errors can contain credential-bearing request details; log only our own.
        const reason =
          error instanceof Error && /^(Original|Managed|Saved|Task changed|Recorded)/.test(error.message)
            ? error.message
            : "Re-verification failed; the task row is unchanged. Check provider access and operator configuration.";
        console.error(JSON.stringify({ ...ids, status: "error", reason }));
        process.exitCode = 1;
      }
    }
  } finally {
    await database.close();
  }
}
