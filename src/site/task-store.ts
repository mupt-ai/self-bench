import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../db/client.js";
import { tasks, users } from "../db/schema.js";
import { TaskNotFoundError, tombstoneTask } from "./task-deletion.js";
import { reserveTaskStart } from "./task-start-reservation.js";

export type PipelineStatus = (typeof tasks.$inferSelect)["pipelineStatus"];
export type ReviewDecision = "approve" | "reject";

/** One candidate the pipeline processed, as stored; files and artifacts stay in the bucket. */
export interface TaskRecord {
  readonly id: number;
  readonly repoId: number;
  readonly runId: string;
  readonly candidateId: string;
  readonly taskId: string;
  readonly sourcePr?: number;
  readonly sourceUrl?: string;
  readonly difficulty: "easy" | "medium" | "hard";
  readonly pipelineStatus: PipelineStatus;
  readonly stage: string;
  readonly round?: number;
  readonly reason?: string;
  readonly bundleKey?: string;
  readonly definition?: Record<string, unknown>;
  readonly review?: {
    readonly decision: ReviewDecision;
    readonly note: string;
    readonly decidedBy: string;
    readonly decidedAt: string;
  };
  readonly syncedAt: string;
  /** Set when the site started this task itself. */
  readonly workflowId?: string;
  readonly startedBy?: string;
  readonly startedAt?: string;
}

/** What a sync writes; identity is (runId, candidateId), reviews are never touched by a sync. */
export type TaskUpsert = Omit<
  TaskRecord,
  "id" | "review" | "syncedAt" | "workflowId" | "startedBy" | "startedAt"
>;

/** A task the site just started: no verdict yet, a workflow to watch. */
export interface TaskStart extends TaskUpsert {
  readonly workflowId: string;
  readonly startedBy: number;
}

export interface TaskProgressPatch {
  readonly stage: string;
  readonly round?: number;
  readonly pipelineStatus: PipelineStatus;
  readonly reason?: string;
  readonly taskId?: string;
}

export interface RepoTaskCounts {
  readonly repoId: number;
  readonly total: number;
  readonly accepted: number;
  readonly needsReview: number;
  readonly rejected: number;
  readonly lastPr?: number;
}

export interface TaskStore {
  upsertMany(rows: readonly TaskUpsert[]): Promise<void>;
  /** Inserts a site-started task; rejects when the workflow id is already known. */
  insertStarted(row: TaskStart): Promise<TaskRecord>;
  reserveStarted(row: TaskStart): Promise<TaskRecord>;
  inProgress(repoId: number): Promise<TaskRecord[]>;
  progress(taskRowId: number, patch: TaskProgressPatch): Promise<TaskRecord>;
  listForRepo(repoId: number): Promise<TaskRecord[]>;
  /** By the agent's task id or the candidate id, within one run. */
  find(repoId: number, runId: string, taskOrCandidateId: string): Promise<TaskRecord | undefined>;
  /** Atomically tombstones a terminal task. Repeating a deletion succeeds. */
  deleteTask(
    repoId: number,
    runId: string,
    taskId: string,
  ): Promise<"deleted" | "active" | "missing">;
  review(
    taskRowId: number,
    verdict: { decision: ReviewDecision; note: string; userId: number },
  ): Promise<TaskRecord>;
  clearReview(taskRowId: number): Promise<TaskRecord>;
  countsForRepos(repoIds: readonly number[]): Promise<RepoTaskCounts[]>;
}

const reviewers = alias(users, "reviewers");
const starters = alias(users, "starters");

export function createTaskStore(db: Database, options: { now?: () => Date } = {}): TaskStore {
  const now = options.now ?? (() => new Date());
  const select = () =>
    db
      .select({ task: tasks, reviewedBy: reviewers.login, startedBy: starters.login })
      .from(tasks)
      .leftJoin(reviewers, eq(reviewers.id, tasks.reviewedBy))
      .leftJoin(starters, eq(starters.id, tasks.startedBy));
  const byId = async (id: number, visibleOnly = false): Promise<TaskRecord> => {
    const [row] = await select().where(
      and(eq(tasks.id, id), visibleOnly ? isNull(tasks.deletedAt) : undefined),
    );
    if (!row) throw new TaskNotFoundError();
    return taskFrom(row);
  };
  const values = (row: TaskUpsert) => ({
    repoId: row.repoId,
    runId: row.runId,
    candidateId: row.candidateId,
    taskId: row.taskId,
    sourcePr: row.sourcePr ?? null,
    sourceUrl: row.sourceUrl ?? null,
    difficulty: row.difficulty,
    pipelineStatus: row.pipelineStatus,
    stage: row.stage,
    round: row.round ?? null,
    reason: row.reason ?? null,
    bundleKey: row.bundleKey ?? null,
    definition: row.definition ?? null,
    syncedAt: now(),
  });
  return {
    async upsertMany(rows) {
      if (rows.length === 0) return;
      await db.transaction(async (tx) => {
        for (const row of rows) {
          const { repoId: _repo, runId: _run, candidateId: _candidate, ...set } = values(row);
          await tx
            .insert(tasks)
            .values(values(row))
            .onConflictDoUpdate({
              target: [tasks.runId, tasks.candidateId],
              set,
              setWhere: sql`${tasks.repoId} = ${row.repoId}
                and ${tasks.deletedAt} is null
                and (${tasks.workflowId} is null or ${tasks.pipelineStatus} <> 'in_progress')`,
            });
        }
      });
    },
    async insertStarted(row) {
      const [inserted] = await db
        .insert(tasks)
        .values({
          ...values(row),
          workflowId: row.workflowId,
          startedBy: row.startedBy,
          startedAt: now(),
        })
        .returning({ id: tasks.id });
      if (!inserted) throw new Error("task insert returned no row");
      return byId(inserted.id);
    },
    async reserveStarted(row) {
      return byId(
        await reserveTaskStart(db, { ...values(row), startedBy: row.startedBy, startedAt: now() }),
      );
    },
    async inProgress(repoId) {
      const rows = await select().where(
        and(
          eq(tasks.repoId, repoId),
          isNull(tasks.deletedAt),
          eq(tasks.pipelineStatus, "in_progress"),
          isNotNull(tasks.workflowId),
        ),
      );
      return rows.map(taskFrom);
    },
    async progress(taskRowId, patch) {
      await db
        .update(tasks)
        .set({
          stage: patch.stage,
          round: patch.round ?? null,
          pipelineStatus: patch.pipelineStatus,
          reason: patch.reason ?? null,
          ...(patch.taskId ? { taskId: patch.taskId } : {}),
          syncedAt: now(),
        })
        .where(and(eq(tasks.id, taskRowId), isNull(tasks.deletedAt)));
      return byId(taskRowId);
    },
    async listForRepo(repoId) {
      const rows = await select()
        .where(and(eq(tasks.repoId, repoId), isNull(tasks.deletedAt)))
        .orderBy(tasks.runId, tasks.taskId);
      return rows.map(taskFrom);
    },
    async find(repoId, runId, taskOrCandidateId) {
      const rows = await select()
        .where(
          and(
            eq(tasks.repoId, repoId),
            isNull(tasks.deletedAt),
            eq(tasks.runId, runId),
            or(eq(tasks.taskId, taskOrCandidateId), eq(tasks.candidateId, taskOrCandidateId)),
          ),
        )
        .orderBy(desc(sql`(${tasks.taskId} = ${taskOrCandidateId})`))
        .limit(1);
      return rows[0] ? taskFrom(rows[0]) : undefined;
    },
    deleteTask: (repoId, runId, taskId) => tombstoneTask(db, repoId, runId, taskId, now),
    async review(taskRowId, verdict) {
      await db
        .update(tasks)
        .set({
          reviewDecision: verdict.decision,
          reviewNote: verdict.note,
          reviewedBy: verdict.userId,
          reviewedAt: now(),
        })
        .where(and(eq(tasks.id, taskRowId), isNull(tasks.deletedAt)));
      return byId(taskRowId, true);
    },
    async clearReview(taskRowId) {
      await db
        .update(tasks)
        .set({ reviewDecision: null, reviewNote: null, reviewedBy: null, reviewedAt: null })
        .where(and(eq(tasks.id, taskRowId), isNull(tasks.deletedAt)));
      return byId(taskRowId, true);
    },
    async countsForRepos(repoIds) {
      if (repoIds.length === 0) return [];
      const count = (condition: ReturnType<typeof sql>) =>
        sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
      const rows = await db
        .select({
          repoId: tasks.repoId,
          total: sql<number>`count(*)`.mapWith(Number),
          accepted: count(sql`${tasks.reviewDecision} = 'approve'`),
          needsReview: count(
            sql`${tasks.reviewDecision} is null and ${tasks.pipelineStatus} = 'accepted'`,
          ),
          rejected: count(
            sql`${tasks.reviewDecision} = 'reject' or (${tasks.reviewDecision} is null and ${tasks.pipelineStatus} in ('rejected', 'infrastructure_failed'))`,
          ),
          lastPr: sql<number | null>`max(${tasks.sourcePr})`,
        })
        .from(tasks)
        .where(and(inArray(tasks.repoId, [...repoIds]), isNull(tasks.deletedAt)))
        .groupBy(tasks.repoId);
      return rows.map((row) => ({
        repoId: row.repoId,
        total: row.total,
        accepted: row.accepted,
        needsReview: row.needsReview,
        rejected: row.rejected,
        ...(row.lastPr !== null ? { lastPr: Number(row.lastPr) } : {}),
      }));
    },
  };
}

function taskFrom(row: {
  task: typeof tasks.$inferSelect;
  reviewedBy: string | null;
  startedBy: string | null;
}): TaskRecord {
  const { task } = row;
  return {
    id: task.id,
    repoId: task.repoId,
    runId: task.runId,
    candidateId: task.candidateId,
    taskId: task.taskId,
    ...(task.sourcePr !== null ? { sourcePr: task.sourcePr } : {}),
    ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
    difficulty: task.difficulty,
    pipelineStatus: task.pipelineStatus,
    stage: task.stage,
    ...(task.round !== null ? { round: task.round } : {}),
    ...(task.reason ? { reason: task.reason } : {}),
    ...(task.bundleKey ? { bundleKey: task.bundleKey } : {}),
    ...(task.definition ? { definition: task.definition } : {}),
    ...(task.reviewDecision
      ? {
          review: {
            decision: task.reviewDecision,
            note: task.reviewNote ?? "",
            decidedBy: row.reviewedBy ?? "",
            decidedAt: (task.reviewedAt ?? new Date(0)).toISOString(),
          },
        }
      : {}),
    syncedAt: task.syncedAt.toISOString(),
    ...(task.workflowId ? { workflowId: task.workflowId } : {}),
    ...(row.startedBy ? { startedBy: row.startedBy } : {}),
    ...(task.startedAt ? { startedAt: task.startedAt.toISOString() } : {}),
  };
}
