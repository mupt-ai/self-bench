import { dirname } from "node:path";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { TaskImages } from "../../contracts/index.js";
import type { Database } from "../../db/client.js";
import { comparisons, releases, tasks } from "../../db/schema.js";
import type { Vault } from "../../db/vault.js";
import { harborProcessEnvironment } from "../../harnesses/harbor/command.js";
import { googleAccessToken } from "../../lib/google-access-token.js";
import {
  providerCredentialEnvironment,
  providerEnvironment,
} from "../../sandbox/provider-environment.js";
import { managedModalEnvironment, managedSandboxCredentials } from "../billing/managed.js";
import { publishExecutionBundle } from "../pipeline/execution-bundle.js";
import { exportTaskImages } from "../pipeline/task-image-export.js";
import { generationRecordPath } from "../settings/credentials.js";
import type { GenerationReference } from "../settings/settings.js";
import { parseImageReference } from "../task/image-registry.js";

const EXECUTION_BUNDLE = "/execution-task.tar.gz";
const COMPILED_BUNDLE = "/harbor-task.tar.gz";

export type ReviewedTask = Pick<
  typeof tasks.$inferSelect,
  | "id"
  | "runId"
  | "taskId"
  | "bundleKey"
  | "images"
  | "pipelineStatus"
  | "reviewDecision"
  | "deletedAt"
>;

export type TaskImageOutcome =
  | { readonly status: "planned"; readonly action: "export" | "remove" }
  | { readonly status: "exported"; readonly bundleKey: string }
  | { readonly status: "removed"; readonly bundleKey: string }
  | { readonly status: "kept"; readonly reason: string }
  | { readonly status: "skipped"; readonly reason: string };

export interface TaskImageDependencies {
  readonly apply: boolean;
  readonly repository: string;
  /** The Harbor credentials of the account that verified the task. */
  readonly environment: (provider: TaskImages["provider"]) => Promise<NodeJS.ProcessEnv>;
  /** Switches the row's bundle and images unless the task changed meanwhile. */
  readonly save: (bundleKey: string, images: TaskImages) => Promise<boolean>;
  /** Whether a saved comparison or a release names any of these image digests. */
  readonly referenced: (digests: readonly string[]) => Promise<boolean>;
  readonly removeImage: (image: string) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly exportImages?: typeof exportTaskImages;
  readonly publish?: typeof publishExecutionBundle;
}

/**
 * What a task's exported images should be, given its human review: a task a person approved has
 * its verified images exported and delivered by digest; one a person rejected or deleted loses
 * them, unless a comparison or release already pinned them. Other tasks are left alone, so a
 * cleared review or a task still awaiting one changes nothing.
 */
export function imageAction(task: ReviewedTask): "export" | "remove" | undefined {
  const images = task.images;
  if (!images || !task.bundleKey) return undefined;
  if (images.registry && (task.deletedAt || task.reviewDecision === "reject")) return "remove";
  const approved =
    !task.deletedAt && task.pipelineStatus === "accepted" && task.reviewDecision === "approve";
  // Exported before execution bundles existed: only the bundle is left to publish.
  const unpublished = !!images.registry?.verifier && !task.bundleKey.endsWith(EXECUTION_BUNDLE);
  return approved && (!images.registry || unpublished) ? "export" : undefined;
}

export async function reconcileTaskImages(
  store: ArtifactStore,
  task: ReviewedTask,
  deps: TaskImageDependencies,
): Promise<TaskImageOutcome> {
  const action = imageAction(task);
  if (!action) return { status: "skipped", reason: "Nothing to change for this review" };
  if (!deps.apply) return { status: "planned", action };
  return action === "export"
    ? await exportReviewed(store, task, deps)
    : await removeExported(store, task, deps);
}

async function exportReviewed(
  store: ArtifactStore,
  task: ReviewedTask,
  deps: TaskImageDependencies,
): Promise<TaskImageOutcome> {
  const images = task.images as TaskImages;
  const bundleKey = task.bundleKey as string;
  const metadata = await store.stat(bundleKey);
  if (!metadata) throw new Error("Original compiled bundle is missing");
  const original = {
    taskId: task.taskId,
    bundle: { ...metadata, contentType: "application/gzip" },
    images,
  };
  const exported = images.registry
    ? original
    : await (deps.exportImages ?? exportTaskImages)(store, original, {
        repository: deps.repository,
        env: harborProcessEnvironment(await deps.environment(images.provider)),
        token: googleAccessToken,
        signal: deps.signal ?? new AbortController().signal,
      });
  if (!exported.images?.registry?.agent) throw new Error("Export produced no agent image");
  // Tasks with services have no separate verifier image and keep their full build bundle.
  const delivered = await (deps.publish ?? publishExecutionBundle)(
    store,
    exported,
    deps.signal ?? new AbortController().signal,
  );
  const deliveredKey = artifactKey(delivered.bundle.uri);
  if (!(await deps.save(deliveredKey, delivered.images as TaskImages)))
    throw new Error("Task changed during export; original row preserved");
  return { status: "exported", bundleKey: deliveredKey };
}

async function removeExported(
  store: ArtifactStore,
  task: ReviewedTask,
  deps: TaskImageDependencies,
): Promise<TaskImageOutcome> {
  const images = task.images as TaskImages;
  const registry = images.registry as NonNullable<TaskImages["registry"]>;
  const exported = [registry.agent, ...(registry.verifier ? [registry.verifier] : [])];
  const digests = exported.map((image) => image.slice(image.indexOf("@") + 1));
  if (await deps.referenced(digests))
    return { status: "kept", reason: "A comparison or release pins these images" };
  // Back to the compiled bundle first, so a later approval can export again from it.
  const bundleKey = compiledBundleKey(task.bundleKey as string);
  if (!(await store.stat(bundleKey))) throw new Error("Original compiled bundle is missing");
  const { registry: _removed, ...unexported } = images;
  if (!(await deps.save(bundleKey, unexported as TaskImages)))
    throw new Error("Task changed during removal; images preserved");
  for (const image of exported) await deps.removeImage(image);
  return { status: "removed", bundleKey };
}

/** The compiled bundle an execution bundle was published beside (publishExecutionBundle). */
export function compiledBundleKey(bundleKey: string): string {
  if (!bundleKey.endsWith(EXECUTION_BUNDLE)) return bundleKey;
  return `${dirname(dirname(bundleKey))}${COMPILED_BUNDLE}`;
}

function artifactKey(uri: string): string {
  const index = uri.indexOf("/runs/");
  if (index < 0) throw new Error("Task bundle has no generation artifact key");
  return uri.slice(index + 1);
}

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
  const orgId = reference.orgId ?? reference.ownerId;
  const original = settings.harborEnvironment ?? settings.sandbox;
  if (original !== provider)
    throw new Error("Saved verification provider does not match the task's images");
  const id = settings.harborEnvironment
    ? settings.harborCredentialId
    : settings.sandboxCredentialId;
  if (!id) throw new Error("Original verification credential is missing");
  const credential = await vault.credentials.find(orgId, id);
  if (!credential || credential.kind !== provider || credential.auth !== "api-key")
    throw new Error("Original verification credential is unavailable");
  const secret = await vault.credentials.secret(orgId, id);
  if (!secret?.value) throw new Error("Original verification credential is unavailable");
  // Start from the runtime whitelist, not the worker's provider credentials or overrides.
  return { ...runtime, ...providerCredentialEnvironment(provider, secret) };
}

/**
 * Deletes one exported image version from Artifact Registry. An image already gone is not an
 * error, so a retried removal finishes.
 */
export async function removeRegistryImage(
  image: string,
  token: () => Promise<string> = googleAccessToken,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const parsed = parseImageReference(image);
  const [project, repository, ...name] = parsed?.repository.split("/") ?? [];
  const location = parsed?.host.replace(/-docker\.pkg\.dev$/, "");
  if (!parsed?.digest || !project || !repository || !name.length || location === parsed.host)
    throw new Error("Not an Artifact Registry image by digest");
  const url =
    `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${location}` +
    `/repositories/${repository}/packages/${encodeURIComponent(name.join("/"))}` +
    `/versions/${parsed.digest}?force=true`;
  const response = await fetcher(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${await token()}` },
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`Artifact Registry answered ${response.status} deleting a task image`);
}

/** The database side of reconciling one task row, guarded against concurrent changes. */
export function taskImageRows(db: Database) {
  return {
    async find(taskRowId: number): Promise<ReviewedTask | undefined> {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskRowId));
      return row;
    },
    async save(task: ReviewedTask, bundleKey: string, images: TaskImages): Promise<boolean> {
      const changed = await db
        .update(tasks)
        .set({ bundleKey, images })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.bundleKey, task.bundleKey ?? ""),
            task.reviewDecision === null
              ? isNull(tasks.reviewDecision)
              : eq(tasks.reviewDecision, task.reviewDecision),
            task.deletedAt === null ? isNull(tasks.deletedAt) : sql`${tasks.deletedAt} is not null`,
            sql`${tasks.images} = ${JSON.stringify(task.images)}::jsonb`,
          ),
        )
        .returning({ id: tasks.id });
      return changed.length === 1;
    },
    async referenced(digests: readonly string[]): Promise<boolean> {
      const patterns = digests.map((digest) => `%${digest}%`);
      const named = (column: AnyPgColumn) =>
        or(...patterns.map((pattern) => sql`${column}::text like ${pattern}`));
      const [comparison] = await db
        .select({ id: comparisons.id })
        .from(comparisons)
        .where(named(comparisons.inputs))
        .limit(1);
      if (comparison) return true;
      const [release] = await db
        .select({ id: releases.id })
        .from(releases)
        .where(or(named(releases.payload), named(releases.detail)))
        .limit(1);
      return !!release;
    },
  };
}

/**
 * Reconciles one task row's exported images with its review, with the credentials that verified
 * the task. Used by the worker after each review and by the maintenance backfill.
 */
export function taskImageReconciler(options: {
  readonly db: Database;
  readonly vault: Pick<Vault, "records" | "credentials">;
  readonly store: ArtifactStore;
  readonly repository: string;
  readonly env?: NodeJS.ProcessEnv;
}) {
  const rows = taskImageRows(options.db);
  return async (
    task: ReviewedTask,
    apply: boolean,
    signal?: AbortSignal,
  ): Promise<TaskImageOutcome> =>
    await reconcileTaskImages(options.store, task, {
      apply,
      ...(signal ? { signal } : {}),
      repository: options.repository,
      environment: (provider) =>
        exportEnvironment(options.vault, task.runId, provider, options.env ?? process.env),
      save: (bundleKey, images) => rows.save(task, bundleKey, images),
      referenced: rows.referenced,
      removeImage: (image) => removeRegistryImage(image),
    });
}
