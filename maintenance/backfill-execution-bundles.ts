import { and, eq, isNotNull } from "drizzle-orm";
import { createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { openDatabase } from "../src/db/client.js";
import { tasks } from "../src/db/schema.js";
import { createVault } from "../src/db/vault.js";
import { taskImageReconciler } from "../src/generation/tasks/task-images.js";

/**
 * Brings existing tasks' exported images in line with their human reviews, as the worker now does
 * after each review: approved tasks get their verified images exported and delivered by digest,
 * rejected or deleted ones lose images no comparison or release pins.
 */
export async function main() {
  const args = process.argv.slice(2);
  const repos = args.filter((arg) => arg !== "--apply");
  if (!repos.length || repos.some((repo) => !/^[1-9]\d*$/.test(repo)))
    throw new Error("Usage: backfill-execution-bundles.js <repoId>... [--apply]");
  const config = loadConfig();
  if (!config.taskImages?.repository) throw new Error("SELFBENCH_TASK_IMAGE_REPOSITORY is required");
  const url = process.env.SELFBENCH_DATABASE_URL;
  const key = process.env.SELFBENCH_EVAL_CREDENTIAL_KEY;
  if (!url || !key) throw new Error("Database and credential encryption configuration required");
  const database = await openDatabase(url, { light: true });
  const reconcile = taskImageReconciler({
    db: database.db,
    vault: createVault(database.db, key),
    store: createArtifactStore(config.artifact),
    repository: config.taskImages.repository,
  });
  const apply = args.includes("--apply");
  try {
    for (const repo of repos) {
      const rows = await database.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.repoId, Number(repo)), isNotNull(tasks.bundleKey), isNotNull(tasks.images)))
        .orderBy(tasks.id);
      for (const task of rows) {
        const ids = { repoId: Number(repo), taskId: task.taskId, runId: task.runId };
        try {
          const result = await reconcile(task, apply);
          if (result.status !== "skipped") console.log(JSON.stringify({ ...ids, ...result }));
        } catch {
          // Provider errors can contain credential-bearing request details; do not log them.
          console.error(
            JSON.stringify({
              ...ids,
              status: "failed",
              reason:
                "Reconciliation failed. Check provider image availability and operator configuration.",
            }),
          );
          process.exitCode = 1;
        }
      }
    }
  } finally {
    await database.close();
  }
}
