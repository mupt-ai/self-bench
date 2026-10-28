import { and, eq, isNull } from "drizzle-orm";
import type { TaskImages } from "../contracts/index.js";
import type { Database } from "./client.js";
import { tasks } from "./schema.js";

/**
 * A task row's lifecycle. The candidate workflow that owns a row is its only writer until it
 * settles: `plan` creates it in progress, `progress` moves its stage, and `settle` gives it its
 * one verdict. Every write is guarded on the row still being in progress and not deleted, so a
 * retried or late activity never rewrites a settled task; a person's review and deletion apply
 * only to settled rows.
 */

/** One planned candidate: in progress, no verdict yet. */
export interface PlannedTask {
  readonly repoId: number;
  readonly runId: string;
  readonly candidateId: string;
  readonly taskId: string;
  readonly sourcePr?: number;
  readonly sourceUrl?: string;
  readonly baseCommit: string;
  readonly difficulty: "easy" | "medium" | "hard";
  readonly stage: string;
  /** The candidate workflow that owns the row. */
  readonly workflowId: string;
}

/** Where a running candidate is. */
export interface TaskProgressPatch {
  readonly stage: string;
  readonly round?: number;
  readonly taskId?: string;
}

/** A candidate's verdict; an accepted one carries what its trials run. */
export interface TaskVerdict extends TaskProgressPatch {
  readonly pipelineStatus: "accepted" | "rejected" | "infrastructure_failed";
  readonly reason?: string;
  readonly bundleKey?: string;
  readonly images?: TaskImages;
}

/** The row of one candidate of a run, while its workflow still owns it. */
const running = (runId: string, candidateId?: string) =>
  and(
    eq(tasks.runId, runId),
    candidateId === undefined ? undefined : eq(tasks.candidateId, candidateId),
    eq(tasks.pipelineStatus, "in_progress"),
    isNull(tasks.deletedAt),
  );

export function taskLifecycle(db: Database, now: () => Date) {
  return {
    /** Inserts each row unless its candidate already has one (a retried plan). */
    async plan(rows: readonly PlannedTask[]): Promise<void> {
      if (rows.length === 0) return;
      await db
        .insert(tasks)
        .values(
          rows.map((row) => ({
            repoId: row.repoId,
            runId: row.runId,
            candidateId: row.candidateId,
            taskId: row.taskId,
            sourcePr: row.sourcePr ?? null,
            sourceUrl: row.sourceUrl ?? null,
            baseCommit: row.baseCommit,
            difficulty: row.difficulty,
            pipelineStatus: "in_progress" as const,
            stage: row.stage,
            workflowId: row.workflowId,
            syncedAt: now(),
          })),
        )
        .onConflictDoNothing({ target: [tasks.runId, tasks.candidateId] });
    },
    /** False when the candidate has no running row (none planned, settled, or deleted). */
    async progress(runId: string, candidateId: string, patch: TaskProgressPatch) {
      const changed = await db
        .update(tasks)
        .set({
          stage: patch.stage,
          round: patch.round ?? null,
          ...(patch.taskId ? { taskId: patch.taskId } : {}),
          syncedAt: now(),
        })
        .where(running(runId, candidateId))
        .returning({ id: tasks.id });
      return changed.length > 0;
    },
    /** Settles one candidate; false when it was not running. */
    async settle(runId: string, candidateId: string, verdict: TaskVerdict) {
      const changed = await db
        .update(tasks)
        .set(settled(verdict, now()))
        .where(running(runId, candidateId))
        .returning({ id: tasks.id });
      return changed.length > 0;
    },
    /** Settles every candidate of a run still running, as a batch that stopped leaves them. */
    async settleRun(runId: string, verdict: Omit<TaskVerdict, "taskId" | "round">) {
      await db.update(tasks).set(settled(verdict, now())).where(running(runId));
    },
  };
}

function settled(verdict: TaskVerdict, at: Date) {
  return {
    pipelineStatus: verdict.pipelineStatus,
    stage: verdict.stage,
    ...(verdict.round !== undefined ? { round: verdict.round } : {}),
    ...(verdict.taskId ? { taskId: verdict.taskId } : {}),
    reason: verdict.reason ?? null,
    ...(verdict.bundleKey ? { bundleKey: verdict.bundleKey } : {}),
    ...(verdict.images ? { images: verdict.images } : {}),
    syncedAt: at,
  };
}
