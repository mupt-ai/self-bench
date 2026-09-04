import type { SqlClient } from "../db/sql.js";

/** A pipeline run whose candidates count as a repository's tasks. */
export interface AttachedRun {
  readonly runId: string;
  readonly attachedBy: string;
  readonly attachedAt: string;
}

export type ReviewDecision = "approve" | "reject";

/** A human verdict on one task. */
export interface TaskReview {
  readonly runId: string;
  readonly taskId: string;
  readonly decision: ReviewDecision;
  readonly note: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface TaskStore {
  runsFor(repoId: number): Promise<AttachedRun[]>;
  attachRun(repoId: number, runId: string, userId: number): Promise<AttachedRun>;
  /** True when a row was removed. */
  detachRun(repoId: number, runId: string): Promise<boolean>;
  reviewsFor(repoId: number): Promise<TaskReview[]>;
  review(
    repoId: number,
    runId: string,
    taskId: string,
    verdict: { decision: ReviewDecision; note: string; userId: number },
  ): Promise<TaskReview>;
  clearReview(repoId: number, runId: string, taskId: string): Promise<boolean>;
}

interface RunRow {
  run_id: string;
  attached_by_login: string;
  attached_at: string | Date;
}

interface ReviewRow {
  run_id: string;
  task_id: string;
  decision: ReviewDecision;
  note: string;
  decided_by_login: string;
  decided_at: string | Date;
}

const RUN_SELECT = `select r.run_id, u.login as attached_by_login, r.attached_at
  from repo_runs r join users u on u.id = r.attached_by`;
const REVIEW_SELECT = `select v.run_id, v.task_id, v.decision, v.note, u.login as decided_by_login, v.decided_at
  from task_reviews v join users u on u.id = v.decided_by`;

export function createPostgresTaskStore(
  sql: SqlClient,
  options: { now?: () => Date } = {},
): TaskStore {
  const now = options.now ?? (() => new Date());
  return {
    async runsFor(repoId) {
      const rows = await sql.query<RunRow>(
        `${RUN_SELECT} where r.repo_id = $1 order by r.attached_at desc, r.run_id`,
        [repoId],
      );
      return rows.map(runFrom);
    },
    async attachRun(repoId, runId, userId) {
      await sql.query(
        `insert into repo_runs (repo_id, run_id, attached_by, attached_at) values ($1, $2, $3, $4)
         on conflict (repo_id, run_id) do nothing`,
        [repoId, runId, userId, now()],
      );
      const [row] = await sql.query<RunRow>(
        `${RUN_SELECT} where r.repo_id = $1 and r.run_id = $2`,
        [repoId, runId],
      );
      if (!row) throw new Error("run attach returned no row");
      return runFrom(row);
    },
    async detachRun(repoId, runId) {
      const rows = await sql.query(
        "delete from repo_runs where repo_id = $1 and run_id = $2 returning run_id",
        [repoId, runId],
      );
      return rows.length > 0;
    },
    async reviewsFor(repoId) {
      const rows = await sql.query<ReviewRow>(`${REVIEW_SELECT} where v.repo_id = $1`, [repoId]);
      return rows.map(reviewFrom);
    },
    async review(repoId, runId, taskId, verdict) {
      await sql.query(
        `insert into task_reviews (repo_id, run_id, task_id, decision, note, decided_by, decided_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (repo_id, run_id, task_id) do update
           set decision = excluded.decision, note = excluded.note,
               decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
        [repoId, runId, taskId, verdict.decision, verdict.note, verdict.userId, now()],
      );
      const [row] = await sql.query<ReviewRow>(
        `${REVIEW_SELECT} where v.repo_id = $1 and v.run_id = $2 and v.task_id = $3`,
        [repoId, runId, taskId],
      );
      if (!row) throw new Error("review upsert returned no row");
      return reviewFrom(row);
    },
    async clearReview(repoId, runId, taskId) {
      const rows = await sql.query(
        "delete from task_reviews where repo_id = $1 and run_id = $2 and task_id = $3 returning task_id",
        [repoId, runId, taskId],
      );
      return rows.length > 0;
    },
  };
}

/** Test double with the same contract. */
export function createMemoryTaskStore(logins: Map<number, string>): TaskStore {
  const runs = new Map<string, AttachedRun & { repoId: number }>();
  const reviews = new Map<string, TaskReview & { repoId: number }>();
  const runKey = (repoId: number, runId: string) => `${repoId}:${runId}`;
  const reviewKey = (repoId: number, runId: string, taskId: string) =>
    `${repoId}:${runId}:${taskId}`;
  return {
    async runsFor(repoId) {
      return [...runs.values()].filter((run) => run.repoId === repoId).reverse();
    },
    async attachRun(repoId, runId, userId) {
      const existing = runs.get(runKey(repoId, runId));
      if (existing) return existing;
      const run = {
        repoId,
        runId,
        attachedBy: logins.get(userId) ?? "",
        attachedAt: new Date().toISOString(),
      };
      runs.set(runKey(repoId, runId), run);
      return run;
    },
    async detachRun(repoId, runId) {
      return runs.delete(runKey(repoId, runId));
    },
    async reviewsFor(repoId) {
      return [...reviews.values()].filter((review) => review.repoId === repoId);
    },
    async review(repoId, runId, taskId, verdict) {
      const review = {
        repoId,
        runId,
        taskId,
        decision: verdict.decision,
        note: verdict.note,
        decidedBy: logins.get(verdict.userId) ?? "",
        decidedAt: new Date().toISOString(),
      };
      reviews.set(reviewKey(repoId, runId, taskId), review);
      return review;
    },
    async clearReview(repoId, runId, taskId) {
      return reviews.delete(reviewKey(repoId, runId, taskId));
    },
  };
}

function runFrom(row: RunRow): AttachedRun {
  return {
    runId: row.run_id,
    attachedBy: row.attached_by_login,
    attachedAt: new Date(row.attached_at).toISOString(),
  };
}

function reviewFrom(row: ReviewRow): TaskReview {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    decision: row.decision,
    note: row.note,
    decidedBy: row.decided_by_login,
    decidedAt: new Date(row.decided_at).toISOString(),
  };
}
