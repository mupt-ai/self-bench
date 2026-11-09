import { and, eq, isNull } from "drizzle-orm";
import { candidateWorkflowId, type TaskImages } from "../contracts/index.js";
import type { VariantChanges } from "../contracts/variants.js";
import type { Database } from "./client.js";
import { taskVariants, users } from "./schema.js";
import type { TaskProgressPatch, TaskVerdict } from "./task-lifecycle.js";

type VariantPipelineStatus = (typeof taskVariants.$inferSelect)["pipelineStatus"];

/** A variant as stored (schema.ts `taskVariants`): its task, what it changes, and its one check. */
export interface TaskVariantRecord {
  readonly id: number;
  /** The task row it changes. */
  readonly parentId: number;
  readonly repoId: number;
  readonly label: string;
  readonly changes?: VariantChanges;
  readonly runId: string;
  readonly candidateId: string;
  readonly taskId: string;
  readonly pipelineStatus: VariantPipelineStatus;
  readonly stage: string;
  readonly reason?: string;
  readonly bundleKey?: string;
  readonly images?: TaskImages;
  readonly workflowId?: string;
  readonly startedBy?: string;
  readonly startedAt?: string;
  readonly syncedAt: string;
}

/** A variant the site just started, before its workflow does. */
interface VariantStart {
  readonly parentId: number;
  readonly repoId: number;
  readonly label: string;
  readonly changes: VariantChanges;
  /** A run ID of its own; a collision takes the next attempt suffix, as tasks do. */
  readonly runId: string;
  readonly candidateId: string;
  readonly taskId: string;
  readonly startedBy: number;
}

export interface TaskVariantStore {
  reserve(row: VariantStart): Promise<TaskVariantRecord>;
  /** False when no running variant has this run and candidate, so the row is a task's. */
  progress(runId: string, candidateId: string, patch: TaskProgressPatch): Promise<boolean>;
  settle(runId: string, candidateId: string, verdict: TaskVerdict): Promise<boolean>;
  /** A task's visible variants, oldest first. */
  listForTask(parentId: number): Promise<TaskVariantRecord[]>;
  /** A repository's visible variants. */
  listForRepo(repoId: number): Promise<TaskVariantRecord[]>;
  /** A repository's deleted variants, whose trials leave current results. */
  listDeleted(repoId: number): Promise<TaskVariantRecord[]>;
  /** A visible variant, by its own run. */
  find(repoId: number, runId: string): Promise<TaskVariantRecord | undefined>;
  /** Tombstones a settled variant. Repeating a deletion succeeds. */
  delete(repoId: number, runId: string): Promise<"deleted" | "active" | "missing">;
}

/** An accepted variant with a bundle runs, as long as the task it changes does. */
export function variantRunnable(
  variant: Pick<TaskVariantRecord, "pipelineStatus" | "bundleKey">,
): boolean {
  return variant.pipelineStatus === "accepted" && !!variant.bundleKey;
}

export function createTaskVariantStore(db: Database, now: () => Date): TaskVariantStore {
  const select = () =>
    db
      .select({ variant: taskVariants, startedBy: users.login })
      .from(taskVariants)
      .leftJoin(users, eq(users.id, taskVariants.startedBy));
  const running = (runId: string, candidateId: string) =>
    and(
      eq(taskVariants.runId, runId),
      eq(taskVariants.candidateId, candidateId),
      eq(taskVariants.pipelineStatus, "in_progress"),
      isNull(taskVariants.deletedAt),
    );
  const byId = async (id: number) => {
    const [row] = await select().where(eq(taskVariants.id, id));
    if (!row) throw new Error(`variant ${id} is missing`);
    return variantFrom(row);
  };
  return {
    async reserve(row) {
      for (let attempt = 1; ; attempt++) {
        const runId = `${row.runId}${attempt > 1 ? `-a${attempt}` : ""}`;
        const [inserted] = await db
          .insert(taskVariants)
          .values({
            parentId: row.parentId,
            repoId: row.repoId,
            label: row.label,
            changes: row.changes,
            runId,
            candidateId: row.candidateId,
            taskId: row.taskId,
            pipelineStatus: "in_progress",
            stage: "verifying",
            workflowId: candidateWorkflowId(runId, row.candidateId),
            startedBy: row.startedBy,
            startedAt: now(),
            syncedAt: now(),
          })
          .onConflictDoNothing()
          .returning({ id: taskVariants.id });
        if (inserted) return await byId(inserted.id);
      }
    },
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
    async listForTask(parentId) {
      const rows = await select()
        .where(and(eq(taskVariants.parentId, parentId), isNull(taskVariants.deletedAt)))
        .orderBy(taskVariants.id);
      return rows.map(variantFrom);
    },
    async listForRepo(repoId) {
      const rows = await select()
        .where(and(eq(taskVariants.repoId, repoId), isNull(taskVariants.deletedAt)))
        .orderBy(taskVariants.id);
      return rows.map(variantFrom);
    },
    async listDeleted(repoId) {
      const rows = await select().where(eq(taskVariants.repoId, repoId));
      return rows.filter((row) => row.variant.deletedAt !== null).map(variantFrom);
    },
    async find(repoId, runId) {
      const [row] = await select()
        .where(
          and(
            eq(taskVariants.repoId, repoId),
            eq(taskVariants.runId, runId),
            isNull(taskVariants.deletedAt),
          ),
        )
        .limit(1);
      return row ? variantFrom(row) : undefined;
    },
    delete: (repoId, runId) =>
      db.transaction(async (tx) => {
        const [variant] = await tx
          .select()
          .from(taskVariants)
          .where(and(eq(taskVariants.repoId, repoId), eq(taskVariants.runId, runId)))
          .for("update");
        if (!variant) return "missing";
        if (variant.deletedAt) return "deleted";
        if (variant.pipelineStatus === "in_progress") return "active";
        await tx
          .update(taskVariants)
          .set({ deletedAt: now() })
          .where(eq(taskVariants.id, variant.id));
        return "deleted";
      }),
  };
}

function variantFrom(row: {
  variant: typeof taskVariants.$inferSelect;
  startedBy: string | null;
}): TaskVariantRecord {
  const { variant } = row;
  return {
    id: variant.id,
    parentId: variant.parentId,
    repoId: variant.repoId,
    label: variant.label,
    ...(variant.changes ? { changes: variant.changes } : {}),
    runId: variant.runId,
    candidateId: variant.candidateId,
    taskId: variant.taskId,
    pipelineStatus: variant.pipelineStatus,
    stage: variant.stage,
    ...(variant.reason ? { reason: variant.reason } : {}),
    ...(variant.bundleKey ? { bundleKey: variant.bundleKey } : {}),
    ...(variant.images ? { images: variant.images } : {}),
    ...(variant.workflowId ? { workflowId: variant.workflowId } : {}),
    ...(row.startedBy ? { startedBy: row.startedBy } : {}),
    ...(variant.startedAt ? { startedAt: variant.startedAt.toISOString() } : {}),
    syncedAt: variant.syncedAt.toISOString(),
  };
}
