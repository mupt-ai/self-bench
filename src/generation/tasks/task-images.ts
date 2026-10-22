import { dirname } from "node:path";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { TaskImages } from "../../contracts/index.js";
import type { Database } from "../../db/client.js";
import { comparisons, releases, tasks } from "../../db/schema.js";
import type { Vault } from "../../db/vault.js";
import { harborProcessEnvironment } from "../../harnesses/harbor/command.js";
import { googleAccessToken } from "../../lib/google-access-token.js";
import { publishExecutionBundle } from "../pipeline/execution-bundle.js";
import { exportTaskImages } from "../pipeline/task-image-export.js";
import { exportEnvironment } from "./task-image-credentials.js";
import { registryImageExists, removeRegistryImage } from "./task-image-registry.js";

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
  | { readonly status: "planned"; readonly action: "export" | "publish" | "remove" }
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
  /**
   * Whether a saved comparison, a release, or another approved task row names any of these
   * digests. The task's own row (`exceptTaskId`) does not count, nor do rows nobody approved.
   */
  readonly referenced: (digests: readonly string[], exceptTaskId: number) => Promise<boolean>;
  /** The row as it is now, so a cleanup never removes what a concurrent save just named. */
  readonly current: (taskRowId: number) => Promise<ReviewedTask | undefined>;
  /** Whether the registry still holds this image by digest. */
  readonly imageExists: (image: string) => Promise<boolean>;
  readonly removeImage: (image: string) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly exportImages?: typeof exportTaskImages;
  readonly publish?: typeof publishExecutionBundle;
}

/**
 * What a task's exported images should be, given its human review. A task a person approved should
 * have its images exported ("export") or, when its row already claims them, verified against the
 * registry ("verify"). One a person rejected or deleted loses the images its row claims ("remove").
 * Any other task is left alone, so a cleared review or a task still awaiting one changes nothing.
 */
export function imageAction(task: ReviewedTask): "export" | "verify" | "remove" | undefined {
  const images = task.images;
  if (!images || !task.bundleKey) return undefined;
  if (task.deletedAt || task.reviewDecision === "reject")
    return images.registry ? "remove" : undefined;
  const approved = task.pipelineStatus === "accepted" && task.reviewDecision === "approve";
  if (!approved) return undefined;
  return images.registry ? "verify" : "export";
}

/**
 * Reconciles one task row with the registry. The row is a claim, and a save can fail after the
 * registry has changed, so "verify" checks the claimed digests exist before trusting them: a
 * re-approved task whose images a failed removal deleted is exported again.
 */
export async function reconcileTaskImages(
  store: ArtifactStore,
  task: ReviewedTask,
  deps: TaskImageDependencies,
): Promise<TaskImageOutcome> {
  const action = imageAction(task);
  if (!action) return { status: "skipped", reason: "Nothing to change for this review" };
  if (action === "remove") {
    if (!deps.apply) return { status: "planned", action };
    return await removeExported(store, task, deps);
  }
  const images = task.images as TaskImages;
  const present = images.registry ? await allPresent(images.registry, deps) : false;
  // Exported and in the registry: only a bundle published before execution bundles is left.
  const unpublished =
    !!images.registry?.verifier && !(task.bundleKey ?? "").endsWith(EXECUTION_BUNDLE);
  if (present && !unpublished)
    return { status: "skipped", reason: "Exported images are in the registry" };
  if (!deps.apply) return { status: "planned", action: present ? "publish" : "export" };
  return present
    ? await exportReviewed(store, task, deps, images, { fresh: false })
    : await exportReviewed(store, task, deps, withoutRegistry(images), { fresh: true });
}

async function allPresent(
  registry: NonNullable<TaskImages["registry"]>,
  deps: TaskImageDependencies,
): Promise<boolean> {
  const images = [registry.agent, ...(registry.verifier ? [registry.verifier] : [])];
  return (await Promise.all(images.map((image) => deps.imageExists(image)))).every(Boolean);
}

function withoutRegistry(images: TaskImages): TaskImages {
  const { registry: _claimed, ...unexported } = images;
  return unexported as TaskImages;
}

async function exportReviewed(
  store: ArtifactStore,
  task: ReviewedTask,
  deps: TaskImageDependencies,
  images: TaskImages,
  options: { readonly fresh: boolean },
): Promise<TaskImageOutcome> {
  // Exports and publishes from the compiled bundle, which an execution bundle was published beside.
  const bundleKey = compiledBundleKey(task.bundleKey as string);
  const metadata = await store.stat(bundleKey);
  if (!metadata) throw new Error("Original compiled bundle is missing");
  const original = {
    taskId: task.taskId,
    bundle: { ...metadata, contentType: "application/gzip" },
    images,
  };
  const exported = options.fresh
    ? await (deps.exportImages ?? exportTaskImages)(store, original, {
        repository: deps.repository,
        env: harborProcessEnvironment(await deps.environment(images.provider)),
        token: googleAccessToken,
        signal: deps.signal ?? new AbortController().signal,
      })
    : original;
  if (!exported.images?.registry?.agent) throw new Error("Export produced no agent image");
  // Tasks with services have no separate verifier image and keep their full build bundle.
  const delivered = await (deps.publish ?? publishExecutionBundle)(
    store,
    exported,
    deps.signal ?? new AbortController().signal,
  );
  const deliveredKey = artifactKey(delivered.bundle.uri);
  if (await deps.save(deliveredKey, delivered.images as TaskImages))
    return { status: "exported", bundleKey: deliveredKey };
  // The row did not take the images just pushed, so nothing names them. Remove them, unless a
  // comparison, a release or another row does, and rethrow so the reconcile runs again.
  if (options.fresh) {
    const pushed = [exported.images.registry.agent, exported.images.registry.verifier].filter(
      (image): image is string => !!image,
    );
    // Content-addressed: a concurrent reconcile of this row may have saved the same digests.
    const row = await deps.current(task.id);
    const named = new Set([row?.images?.registry?.agent, row?.images?.registry?.verifier]);
    const orphans = pushed.filter((image) => !named.has(image));
    const digests = orphans.map((image) => image.slice(image.indexOf("@") + 1));
    if (orphans.length && !(await deps.referenced(digests, task.id)))
      for (const image of orphans) await deps.removeImage(image);
  }
  throw new Error("Task changed during export; the next review reconciles it");
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
  // Another row or a pin still uses these images: keep them, and keep the row's claim with them.
  if (await deps.referenced(digests, task.id))
    return { status: "kept", reason: "A comparison, a release or another task pins these images" };
  const bundleKey = compiledBundleKey(task.bundleKey as string);
  if (!(await store.stat(bundleKey))) throw new Error("Original compiled bundle is missing");
  // Delete before the row loses its digests: a failed delete leaves the row naming them, so the
  // retry deletes them again (a missing image counts as done) rather than forgetting them.
  for (const image of exported) await deps.removeImage(image);
  // Back to the compiled bundle, so a later approval can export again from it.
  if (!(await deps.save(bundleKey, withoutRegistry(images))))
    throw new Error("Task changed during removal; the next review reconciles it");
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
            task.images === null
              ? isNull(tasks.images)
              : sql`${tasks.images} = ${JSON.stringify(task.images)}::jsonb`,
          ),
        )
        .returning({ id: tasks.id });
      return changed.length === 1;
    },
    async referenced(digests: readonly string[], exceptTaskId: number): Promise<boolean> {
      const patterns = digests.map((digest) => `%${digest}%`);
      const named = (column: AnyPgColumn) =>
        or(...patterns.map((pattern) => sql`${column}::text like ${pattern}`));
      // Only a row a person approved, still live, needs its images; a rejected row never does.
      const [other] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            ne(tasks.id, exceptTaskId),
            eq(tasks.reviewDecision, "approve"),
            eq(tasks.pipelineStatus, "accepted"),
            isNull(tasks.deletedAt),
            named(tasks.images),
          ),
        )
        .limit(1);
      if (other) return true;
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
      current: rows.find,
      imageExists: (image) => registryImageExists(image),
      removeImage: (image) => removeRegistryImage(image),
    });
}
