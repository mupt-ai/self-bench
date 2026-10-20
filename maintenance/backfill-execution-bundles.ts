import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { type ArtifactStore, createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import type { TaskImages } from "../src/contracts/index.js";
import { openDatabase } from "../src/db/client.js";
import { tasks } from "../src/db/schema.js";
import { createVault, type Vault } from "../src/db/vault.js";
import { managedModalEnvironment, managedSandboxCredentials } from "../src/generation/billing/managed.js";
import { publishExecutionBundle } from "../src/generation/pipeline/execution-bundle.js";
import { exportTaskImages } from "../src/generation/pipeline/task-image-export.js";
import { generationRecordPath } from "../src/generation/settings/credentials.js";
import type { GenerationReference } from "../src/generation/settings/settings.js";
import { harborProcessEnvironment } from "../src/harnesses/harbor/command.js";
import { googleAccessToken } from "../src/lib/google-access-token.js";
import { providerCredentialEnvironment, providerEnvironment } from "../src/sandbox/provider-environment.js";

type SavedTask = Pick<typeof tasks.$inferSelect, "id" | "runId" | "taskId" | "bundleKey" | "images">;

/** Resolve only the original verification account; historical model access is irrelevant. */
export async function exportEnvironment(
  vault: Pick<Vault, "records" | "credentials">,
  runId: string,
  provider: TaskImages["provider"],
  base: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const saved = await vault.records.read<GenerationReference>(generationRecordPath(runId));
  if (!saved) throw new Error("Original generation configuration is missing");
  const reference = saved.value;
  const settings = reference.settings;
  const runtime = providerEnvironment(base, "docker");
  if (settings.sandbox === "managed") {
    if (provider === "modal") return { ...runtime, ...managedModalEnvironment(base) };
    if (provider !== "e2b") throw new Error("Unexpected managed verification provider");
    const secret = managedSandboxCredentials(base);
    return { ...runtime, E2B_API_KEY: secret.apiKey, E2B_DOMAIN: secret.domain };
  }
  const orgId = reference.orgId;
  if (!orgId) throw new Error("Original generation has no credential organization");
  const original = settings.harborEnvironment ?? settings.sandbox;
  if (original !== provider) throw new Error("Saved verification provider does not match the task's images");
  const id = settings.harborEnvironment ? settings.harborCredentialId : settings.sandboxCredentialId;
  if (!id) throw new Error("Original verification credential is missing");
  const credential = await vault.credentials.find(orgId, id);
  if (!credential || credential.kind !== provider || credential.auth !== "api-key")
    throw new Error("Original verification credential is unavailable");
  const secret = await vault.credentials.secret(orgId, id);
  if (!secret?.value) throw new Error("Original verification credential is unavailable");
  // Start from the runtime whitelist, not the worker's provider credentials or overrides.
  return { ...runtime, ...providerCredentialEnvironment(provider, secret) };
}

export async function migrateExecutionBundle(
  store: ArtifactStore,
  task: SavedTask,
  options: {
    apply: boolean;
    repository: string;
    environment: (provider: TaskImages["provider"]) => Promise<NodeJS.ProcessEnv>;
    save: (bundleKey: string, images: TaskImages) => Promise<boolean>;
    exportImages?: typeof exportTaskImages;
    publish?: typeof publishExecutionBundle;
  },
) {
  if (!task.bundleKey || !task.images?.verifier) return { status: "skipped", reason: "Missing bundle or verified image pair" };
  if (task.bundleKey.endsWith("/execution-task.tar.gz")) return { status: "skipped", reason: "Already migrated" };
  if (!options.apply) return { status: "planned", provider: task.images.provider, bundleKey: task.bundleKey };
  const metadata = await store.stat(task.bundleKey);
  if (!metadata) throw new Error("Original compiled bundle is missing");
  const original = { taskId: task.taskId, bundle: { ...metadata, contentType: "application/gzip" }, images: task.images };
  const exported = task.images.registry ? original : await (options.exportImages ?? exportTaskImages)(store, original, {
    repository: options.repository,
    env: harborProcessEnvironment(await options.environment(task.images.provider)),
    token: googleAccessToken,
    signal: new AbortController().signal,
  });
  const delivered = await (options.publish ?? publishExecutionBundle)(store, exported, new AbortController().signal);
  if (delivered.bundle.uri === original.bundle.uri || !delivered.images?.registry?.verifier) throw new Error("Export did not produce an execution bundle");
  const index = delivered.bundle.uri.indexOf("/runs/");
  if (index < 0) throw new Error("Execution bundle has no generation artifact key");
  const bundleKey = delivered.bundle.uri.slice(index + 1);
  if (!await options.save(bundleKey, delivered.images)) throw new Error("Task changed during migration; original row preserved");
  return { status: "migrated", bundleKey };
}

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
  const store = createArtifactStore(config.artifact);
  const vault = createVault(database.db, key);
  try {
    for (const repo of repos) {
      const rows = await database.db.select().from(tasks).where(and(
        eq(tasks.repoId, Number(repo)), eq(tasks.pipelineStatus, "accepted"),
        isNull(tasks.deletedAt), isNotNull(tasks.bundleKey),
      )).orderBy(tasks.id);
      for (const task of rows) {
        try {
          const result = await migrateExecutionBundle(store, task, {
            apply: args.includes("--apply"), repository: config.taskImages.repository,
            environment: (provider) => exportEnvironment(vault, task.runId, provider, process.env),
            save: async (bundleKey, images) => {
              const changed = await database.db.update(tasks).set({ bundleKey, images }).where(and(
                eq(tasks.id, task.id), eq(tasks.bundleKey, task.bundleKey ?? ""), isNull(tasks.deletedAt),
                eq(tasks.pipelineStatus, "accepted"), sql`${tasks.images} = ${JSON.stringify(task.images)}::jsonb`,
              )).returning({ id: tasks.id });
              return changed.length === 1;
            },
          });
          console.log(JSON.stringify({ repoId: Number(repo), taskId: task.taskId, runId: task.runId, ...result }));
        } catch {
          // Provider errors can contain credential-bearing request details; do not log them.
          console.error(JSON.stringify({ taskId: task.taskId, runId: task.runId, status: "failed", reason: "Migration failed; original task remains unchanged. Check provider image availability and operator configuration." }));
          process.exitCode = 1;
        }
      }
    }
  } finally { await database.close(); }
}
