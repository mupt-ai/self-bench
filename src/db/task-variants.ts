import { and, eq, inArray, isNull } from "drizzle-orm";
import { candidateWorkflowId, type TaskImages } from "../contracts/index.js";
import type { Database } from "./client.js";
import { taskEnvironments, tasks, taskVariants, users } from "./schema.js";
import type { TaskProgressPatch, TaskVerdict } from "./task-lifecycle.js";

/** An environment as stored (task-variant-schema.ts): a repository's change to its tasks' files. */
export interface TaskEnvironmentRecord {
  readonly id: number;
  readonly repoId: number;
  readonly name: string;
  /** Run in /app as each task's image is built (generation/tasks/variant.ts). */
  readonly script?: string;
  readonly createdBy?: string;
  readonly createdAt: string;
}

/** One approved task built in one environment, and its one check. */
export interface TaskVariantRecord {
  readonly id: number;
  readonly environmentId: number;
  /** The task row it changes. */
  readonly parentId: number;
  readonly repoId: number;
  readonly runId: string;
  readonly candidateId: string;
  readonly taskId: string;
  readonly pipelineStatus: (typeof taskVariants.$inferSelect)["pipelineStatus"];
  readonly stage: string;
  readonly reason?: string;
  readonly bundleKey?: string;
  readonly images?: TaskImages;
  readonly workflowId?: string;
  readonly syncedAt: string;
}

/** A variant the site just started, before its workflow does. */
interface VariantStart {
  readonly environmentId: number;
  readonly parentId: number;
  readonly repoId: number;
  /** A run ID of its own; a collision takes the next attempt suffix, as tasks do. */
  readonly runId: string;
  readonly candidateId: string;
  readonly taskId: string;
  readonly startedBy: number;
}

export interface TaskVariantStore {
  createEnvironment(row: {
    repoId: number;
    name: string;
    script: string;
    createdBy: number;
  }): Promise<TaskEnvironmentRecord>;
  /** A repository's visible environments, oldest first. */
  listEnvironments(repoId: number): Promise<TaskEnvironmentRecord[]>;
  findEnvironment(repoId: number, id: number): Promise<TaskEnvironmentRecord | undefined>;
  /**
   * Tombstones an environment and its variants; false when it never existed. Repeating it succeeds,
   * so a deletion whose checks did not all stop can be retried (runningChecks).
   */
  deleteEnvironment(repoId: number, id: number): Promise<boolean>;
  /**
   * Checks still running for an environment or a task, deleted ones included: deleting either stops
   * them. A reserve waits for a deletion in progress and refuses one that finished, so a check
   * started meanwhile is either found here or never starts.
   */
  runningChecks(
    repoId: number,
    of: { readonly environmentId: number } | { readonly parentId: number },
  ): Promise<TaskVariantRecord[]>;
  /** Settles checks a deletion stopped, deleted rows included, so none is stopped twice. */
  markStopped(ids: readonly number[]): Promise<void>;
  reserve(row: VariantStart): Promise<TaskVariantRecord>;
  /** False when no running variant has this run and candidate, so the row is a task's. */
  progress(runId: string, candidateId: string, patch: TaskProgressPatch): Promise<boolean>;
  settle(runId: string, candidateId: string, verdict: TaskVerdict): Promise<boolean>;
  /** A repository's visible variants, by environment then task. */
  listForRepo(repoId: number): Promise<TaskVariantRecord[]>;
}

/** An accepted variant with a bundle runs, as long as the task it changes does. */
export function variantRunnable(
  variant: Pick<TaskVariantRecord, "pipelineStatus" | "bundleKey">,
): boolean {
  return variant.pipelineStatus === "accepted" && !!variant.bundleKey;
}

export function createTaskVariantStore(db: Database, now: () => Date): TaskVariantStore {
  const environments = () =>
    db
      .select({ environment: taskEnvironments, createdBy: users.login })
      .from(taskEnvironments)
      .leftJoin(users, eq(users.id, taskEnvironments.createdBy));
  const running = (runId: string, candidateId: string) =>
    and(
      eq(taskVariants.runId, runId),
      eq(taskVariants.candidateId, candidateId),
      eq(taskVariants.pipelineStatus, "in_progress"),
      isNull(taskVariants.deletedAt),
    );
  return {
    async createEnvironment(row) {
      const [created] = await db
        .insert(taskEnvironments)
        .values({
          repoId: row.repoId,
          name: row.name,
          changes: { script: row.script },
          createdBy: row.createdBy,
          createdAt: now(),
        })
        .returning({ id: taskEnvironments.id });
      if (!created) throw new Error("environment was not created");
      const [found] = await environments().where(eq(taskEnvironments.id, created.id));
      if (!found) throw new Error("environment is missing");
      return environmentFrom(found);
    },
    async listEnvironments(repoId) {
      const rows = await environments()
        .where(and(eq(taskEnvironments.repoId, repoId), isNull(taskEnvironments.deletedAt)))
        .orderBy(taskEnvironments.id);
      return rows.map(environmentFrom);
    },
    async findEnvironment(repoId, id) {
      const [row] = await environments().where(
        and(
          eq(taskEnvironments.repoId, repoId),
          eq(taskEnvironments.id, id),
          isNull(taskEnvironments.deletedAt),
        ),
      );
      return row ? environmentFrom(row) : undefined;
    },
    deleteEnvironment: (repoId, id) =>
      db.transaction(async (tx) => {
        const [found] = await tx
          .select({ deletedAt: taskEnvironments.deletedAt })
          .from(taskEnvironments)
          .where(and(eq(taskEnvironments.repoId, repoId), eq(taskEnvironments.id, id)))
          .for("update");
        if (!found) return false;
        if (found.deletedAt) return true;
        await tx
          .update(taskEnvironments)
          .set({ deletedAt: now() })
          .where(eq(taskEnvironments.id, id));
        await tx
          .update(taskVariants)
          .set({ deletedAt: now() })
          .where(and(eq(taskVariants.environmentId, id), isNull(taskVariants.deletedAt)));
        return true;
      }),
    async runningChecks(repoId, of) {
      const rows = await db
        .select()
        .from(taskVariants)
        .where(
          and(
            eq(taskVariants.repoId, repoId),
            eq(taskVariants.pipelineStatus, "in_progress"),
            "environmentId" in of
              ? eq(taskVariants.environmentId, of.environmentId)
              : eq(taskVariants.parentId, of.parentId),
          ),
        );
      return rows.map(variantFrom);
    },
    async markStopped(ids) {
      if (ids.length === 0) return;
      await db
        .update(taskVariants)
        .set({
          pipelineStatus: "infrastructure_failed",
          stage: "cancelled",
          reason: "Stopped when its environment or task was deleted.",
          syncedAt: now(),
        })
        .where(
          and(inArray(taskVariants.id, [...ids]), eq(taskVariants.pipelineStatus, "in_progress")),
        );
    },
    reserve: (row) =>
      db.transaction(async (tx) => {
        // Shared locks: reserves run side by side, but wait for a deletion of either row, and a
        // deletion waits for them, so no check starts unseen by the deletion's stop.
        const [environment] = await tx
          .select({ deletedAt: taskEnvironments.deletedAt })
          .from(taskEnvironments)
          .where(eq(taskEnvironments.id, row.environmentId))
          .for("share");
        const [task] = await tx
          .select({ deletedAt: tasks.deletedAt })
          .from(tasks)
          .where(eq(tasks.id, row.parentId))
          .for("share");
        if (!environment || environment.deletedAt || !task || task.deletedAt)
          throw new Error("The environment or its task was deleted.");
        for (let attempt = 1; ; attempt++) {
          const runId = `${row.runId}${attempt > 1 ? `-a${attempt}` : ""}`;
          const [inserted] = await tx
            .insert(taskVariants)
            .values({
              ...row,
              runId,
              pipelineStatus: "in_progress",
              stage: "verifying",
              workflowId: candidateWorkflowId(runId, row.candidateId),
              startedAt: now(),
              syncedAt: now(),
            })
            .onConflictDoNothing()
            .returning();
          if (inserted) return variantFrom(inserted);
        }
      }),
    async progress(runId, candidateId, patch) {
      const changed = await db
        .update(taskVariants)
        .set({ stage: patch.stage, syncedAt: now() })
        .where(running(runId, candidateId))
        .returning({ id: taskVariants.id });
      return changed.length > 0;
    },
    async settle(runId, candidateId, verdict) {
      const changed = await db
        .update(taskVariants)
        .set({
          pipelineStatus: verdict.pipelineStatus,
          stage: verdict.stage,
          reason: verdict.reason ?? null,
          ...(verdict.bundleKey ? { bundleKey: verdict.bundleKey } : {}),
          ...(verdict.images ? { images: verdict.images } : {}),
          syncedAt: now(),
        })
        .where(running(runId, candidateId))
        .returning({ id: taskVariants.id });
      return changed.length > 0;
    },
    async listForRepo(repoId) {
      const rows = await db
        .select()
        .from(taskVariants)
        .where(and(eq(taskVariants.repoId, repoId), isNull(taskVariants.deletedAt)))
        .orderBy(taskVariants.environmentId, taskVariants.parentId, taskVariants.id);
      return rows.map(variantFrom);
    },
  };
}

function environmentFrom(row: {
  environment: typeof taskEnvironments.$inferSelect;
  createdBy: string | null;
}): TaskEnvironmentRecord {
  const { environment } = row;
  return {
    id: environment.id,
    repoId: environment.repoId,
    name: environment.name,
    ...(environment.changes?.script !== undefined ? { script: environment.changes.script } : {}),
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    createdAt: environment.createdAt.toISOString(),
  };
}

function variantFrom(variant: typeof taskVariants.$inferSelect): TaskVariantRecord {
  return {
    id: variant.id,
    environmentId: variant.environmentId,
    parentId: variant.parentId,
    repoId: variant.repoId,
    runId: variant.runId,
    candidateId: variant.candidateId,
    taskId: variant.taskId,
    pipelineStatus: variant.pipelineStatus,
    stage: variant.stage,
    ...(variant.reason ? { reason: variant.reason } : {}),
    ...(variant.bundleKey ? { bundleKey: variant.bundleKey } : {}),
    ...(variant.images ? { images: variant.images } : {}),
    ...(variant.workflowId ? { workflowId: variant.workflowId } : {}),
    syncedAt: variant.syncedAt.toISOString(),
  };
}
