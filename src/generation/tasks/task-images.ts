import { dirname } from "node:path";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { ArtifactStore } from "../../artifacts/index.js";
import { isArtifactRegistry } from "../../contracts/config/task-images.js";
import type { TaskImages } from "../../contracts/index.js";
import type { Database } from "../../db/client.js";
import { comparisons, releases, tasks } from "../../db/schema.js";
import { removeRegistryImage } from "../images/registry.js";

const EXECUTION_BUNDLE = "/execution-task.tar.gz";
const COMPILED_BUNDLE = "/harbor-task.tar.gz";

export type ReviewedTask = Pick<
  typeof tasks.$inferSelect,
  | "id"
  | "runId"
  | "candidateId"
  | "taskId"
  | "pipelineStatus"
  | "bundleKey"
  | "images"
  | "reviewDecision"
  | "deletedAt"
>;

export type TaskImageOutcome =
  | { readonly status: "removed"; readonly bundleKey: string }
  /** A kept task without images, which a rebuild gives them (task-image-rebuild.ts). */
  | { readonly status: "unbuilt" }
  | { readonly status: "kept"; readonly reason: string }
  | { readonly status: "skipped"; readonly reason: string };

export interface TaskImageDependencies {
  /** Returns the row to `bundleKey` without images, unless the task changed meanwhile. */
  readonly save: (bundleKey: string) => Promise<boolean>;
  /**
   * Whether a saved comparison, a release, or another approved task row names any of these
   * digests. The task's own row (`exceptTaskId`) does not count, nor do rows nobody approved.
   */
  readonly referenced: (digests: readonly string[], exceptTaskId: number) => Promise<boolean>;
  readonly removeImage: (image: string) => Promise<void>;
}

/** A task a person rejected or deleted gives up its images; any other keeps them. */
export function removesImages(task: ReviewedTask): boolean {
  return (
    !!task.images && !!task.bundleKey && (!!task.deletedAt || task.reviewDecision === "reject")
  );
}

/**
 * Removes a rejected or deleted task's images, unless something still pins them, and returns its
 * row to the compiled bundle (which builds the task's Dockerfiles) without them. The images go
 * before the row forgets them: a failed deletion leaves the row naming them, so the retry deletes
 * them again (a missing image counts as gone) rather than leaking them.
 */
export async function reconcileTaskImages(
  store: ArtifactStore,
  task: ReviewedTask,
  deps: TaskImageDependencies,
): Promise<TaskImageOutcome> {
  if (!removesImages(task))
    return { status: "skipped", reason: "Nothing to change for this review" };
  const images = task.images as TaskImages;
  const named = [images.agent, images.verifier];
  const digests = named.map((image) => image.slice(image.indexOf("@") + 1));
  if (await deps.referenced(digests, task.id))
    return { status: "kept", reason: "A comparison, a release or another task pins these images" };
  const bundleKey = compiledBundleKey(task.bundleKey as string);
  if (!(await store.stat(bundleKey))) throw new Error("Original compiled bundle is missing");
  for (const image of named) await deps.removeImage(image);
  if (!(await deps.save(bundleKey)))
    throw new Error("Task changed during removal; the next review reconciles it");
  return { status: "removed", bundleKey };
}

/** The compiled bundle an execution bundle was published beside (publishExecutionBundle). */
export function compiledBundleKey(bundleKey: string): string {
  if (!bundleKey.endsWith(EXECUTION_BUNDLE)) return bundleKey;
  return `${dirname(dirname(bundleKey))}${COMPILED_BUNDLE}`;
}

/** The database side of reconciling one task row, guarded against concurrent changes. */
export function taskImageRows(db: Database) {
  /** Sets `values` on the row unless the task changed since it was read. */
  const update = async (
    task: ReviewedTask,
    values: Partial<typeof tasks.$inferInsert>,
  ): Promise<boolean> => {
    const changed = await db
      .update(tasks)
      .set(values)
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
  };
  const kept = (repoIds?: readonly number[]) =>
    and(
      eq(tasks.pipelineStatus, "accepted"),
      isNull(tasks.deletedAt),
      or(isNull(tasks.reviewDecision), ne(tasks.reviewDecision, "reject")),
      repoIds?.length ? inArray(tasks.repoId, [...repoIds]) : undefined,
    );
  return {
    async find(taskRowId: number): Promise<ReviewedTask | undefined> {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskRowId));
      return row;
    },
    /** Switches the row's bundle and images unless the task changed since it was read. */
    save: (task: ReviewedTask, bundleKey: string, images?: TaskImages) =>
      update(task, { bundleKey, images: images ?? null }),
    /** A converted task's native bundle and images; it no longer has a definition. */
    saveConverted: (task: ReviewedTask, bundleKey: string, images: TaskImages) =>
      update(task, { bundleKey, images, definition: null }),
    /** Accepted, kept rows still authored as definition.json (task-conversion.ts). */
    async legacy(repoIds?: readonly number[]): Promise<number[]> {
      const rows = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(kept(repoIds), sql`${tasks.definition} is not null`))
        .orderBy(tasks.id);
      return rows.map((row) => row.id);
    },
    /** Accepted, kept rows that run on their Dockerfiles, optionally within some repositories. */
    async withoutImages(repoIds?: readonly number[]): Promise<number[]> {
      const rows = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(kept(repoIds), isNull(tasks.images)))
        .orderBy(tasks.id);
      return rows.map((row) => row.id);
    },
    async referenced(digests: readonly string[], exceptTaskId: number): Promise<boolean> {
      const patterns = digests.map((digest) => `%${digest}%`);
      const named = (column: AnyPgColumn) =>
        or(...patterns.map((pattern) => sql`${column}::text like ${pattern}`));
      // A live row nobody rejected still runs on its images.
      const [other] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            ne(tasks.id, exceptTaskId),
            or(isNull(tasks.reviewDecision), eq(tasks.reviewDecision, "approve")),
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

/** Reconciles one task row's images with its review. */
export function taskImageReconciler(options: {
  readonly db: Database;
  readonly store: ArtifactStore;
  /** The task image repository; a local registry keeps its images, so only the row changes. */
  readonly repository: string | undefined;
}) {
  const deletes = !!options.repository && isArtifactRegistry(options.repository);
  const rows = taskImageRows(options.db);
  return async (task: ReviewedTask): Promise<TaskImageOutcome> =>
    await reconcileTaskImages(options.store, task, {
      save: (bundleKey) => rows.save(task, bundleKey),
      referenced: rows.referenced,
      removeImage: async (image) => {
        if (deletes) await removeRegistryImage(image);
      },
    });
}
