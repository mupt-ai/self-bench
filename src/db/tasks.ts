import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { TaskImages } from "../contracts/index.js";
import {
  TaskNotFoundError,
  TaskNotSettledError,
  tombstoneTask,
} from "../generation/tasks/deletion.js";
import { reserveTaskStart } from "../generation/tasks/start-reservation.js";
import type { Database } from "./client.js";
import { tasks, users } from "./schema.js";
import { taskCountsForRepos } from "./task-counts.js";
import { type PlannedTask, taskLifecycle } from "./task-lifecycle.js";
import { taskFrom } from "./task-record.js";

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
  readonly baseCommit?: string;
  readonly difficulty: "easy" | "medium" | "hard";
  readonly pipelineStatus: PipelineStatus;
  readonly stage: string;
  readonly round?: number;
  readonly reason?: string;
  readonly bundleKey?: string;
  /** The images the accepted task's trials start from. */
  readonly images?: TaskImages;
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
  /** The task a person's feedback revised into this one. */
  readonly revisedFrom?: { readonly runId: string; readonly taskId: string };
  readonly feedback?: string;
}

/** A task the site just started: no verdict yet, a workflow to own it. */
interface TaskStart extends Omit<PlannedTask, "workflowId"> {
  readonly startedBy: number;
  /** A revision: the row it revises and the feedback it addresses. */
  readonly revision?: { readonly from: number; readonly feedback: string };
}

interface RepoTaskCounts {
  readonly repoId: number;
  readonly total: number;
  readonly accepted: number;
  readonly needsReview: number;
  readonly rejected: number;
  readonly lastPr?: number;
}

export interface TaskStore extends ReturnType<typeof taskLifecycle> {
  /** Reserves a site-started task's row under a run ID of its own, before its workflow starts. */
  reserveStarted(row: TaskStart): Promise<TaskRecord>;
  listForRepo(repoId: number): Promise<TaskRecord[]>;
  /** Every visible task of one run. */
  listForRun(runId: string): Promise<TaskRecord[]>;
  /** Every task of a repository, deleted ones included; a release records them all. */
  listWithDeleted(repoId: number): Promise<(TaskRecord & { readonly deleted: boolean })[]>;
  /** By the agent's task id or the candidate id, within one run. */
  find(repoId: number, runId: string, taskOrCandidateId: string): Promise<TaskRecord | undefined>;
  /** The visible tasks feedback revised this one into, oldest first. */
  revisionsOf(taskRowId: number): Promise<TaskRecord[]>;
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
const origins = alias(tasks, "origins");

export function createTaskStore(db: Database, options: { now?: () => Date } = {}): TaskStore {
  const now = options.now ?? (() => new Date());
  const select = () =>
    db
      .select({
        task: tasks,
        reviewedBy: reviewers.login,
        startedBy: starters.login,
        origin: { runId: origins.runId, taskId: origins.taskId },
      })
      .from(tasks)
      .leftJoin(reviewers, eq(reviewers.id, tasks.reviewedBy))
      .leftJoin(starters, eq(starters.id, tasks.startedBy))
      .leftJoin(origins, eq(origins.id, tasks.revisedFrom));
  const byId = async (id: number, visibleOnly = false): Promise<TaskRecord> => {
    const [row] = await select().where(
      and(eq(tasks.id, id), visibleOnly ? isNull(tasks.deletedAt) : undefined),
    );
    if (!row) throw new TaskNotFoundError();
    return taskFrom(row);
  };
  // A person reviews only a task its workflow has settled.
  const reviewSettled = async (
    taskRowId: number,
    review: Pick<
      typeof tasks.$inferInsert,
      "reviewDecision" | "reviewNote" | "reviewedBy" | "reviewedAt"
    >,
  ): Promise<TaskRecord> => {
    const changed = await db
      .update(tasks)
      .set(review)
      .where(
        and(
          eq(tasks.id, taskRowId),
          isNull(tasks.deletedAt),
          ne(tasks.pipelineStatus, "in_progress"),
        ),
      )
      .returning({ id: tasks.id });
    const task = await byId(taskRowId, true);
    if (changed.length === 0) throw new TaskNotSettledError();
    return task;
  };
  return {
    ...taskLifecycle(db, now),
    async reserveStarted(row) {
      return byId(
        await reserveTaskStart(db, {
          repoId: row.repoId,
          runId: row.runId,
          candidateId: row.candidateId,
          taskId: row.taskId,
          sourcePr: row.sourcePr ?? null,
          sourceUrl: row.sourceUrl ?? null,
          baseCommit: row.baseCommit,
          difficulty: row.difficulty,
          pipelineStatus: "in_progress",
          stage: row.stage,
          syncedAt: now(),
          startedBy: row.startedBy,
          startedAt: now(),
          ...(row.revision
            ? { revisedFrom: row.revision.from, feedback: row.revision.feedback }
            : {}),
        }),
      );
    },
    async listForRepo(repoId) {
      const rows = await select()
        .where(and(eq(tasks.repoId, repoId), isNull(tasks.deletedAt)))
        .orderBy(tasks.runId, tasks.taskId);
      return rows.map(taskFrom);
    },
    async listForRun(runId) {
      const rows = await select()
        .where(and(eq(tasks.runId, runId), isNull(tasks.deletedAt)))
        .orderBy(tasks.candidateId);
      return rows.map(taskFrom);
    },
    async listWithDeleted(repoId) {
      const rows = await select()
        .where(eq(tasks.repoId, repoId))
        .orderBy(tasks.runId, tasks.taskId);
      return rows.map((row) => ({ ...taskFrom(row), deleted: row.task.deletedAt !== null }));
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
    async revisionsOf(taskRowId) {
      const rows = await select()
        .where(and(eq(tasks.revisedFrom, taskRowId), isNull(tasks.deletedAt)))
        .orderBy(tasks.id);
      return rows.map(taskFrom);
    },
    deleteTask: (repoId, runId, taskId) => tombstoneTask(db, repoId, runId, taskId, now),
    review: (taskRowId, verdict) =>
      reviewSettled(taskRowId, {
        reviewDecision: verdict.decision,
        reviewNote: verdict.note,
        reviewedBy: verdict.userId,
        reviewedAt: now(),
      }),
    clearReview: (taskRowId) =>
      reviewSettled(taskRowId, {
        reviewDecision: null,
        reviewNote: null,
        reviewedBy: null,
        reviewedAt: null,
      }),
    countsForRepos: (repoIds) => taskCountsForRepos(db, repoIds),
  };
}
