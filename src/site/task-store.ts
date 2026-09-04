import type { SqlClient } from "../db/sql.js";

export type PipelineStatus = "in_progress" | "accepted" | "rejected" | "infrastructure_failed";
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
}

/** What a sync writes; identity is (runId, candidateId), reviews are never touched by a sync. */
export type TaskUpsert = Omit<TaskRecord, "id" | "review" | "syncedAt">;

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
  listForRepo(repoId: number): Promise<TaskRecord[]>;
  /** By the agent's task id or the candidate id, within one run. */
  find(repoId: number, runId: string, taskOrCandidateId: string): Promise<TaskRecord | undefined>;
  deleteForRun(repoId: number, runId: string): Promise<number>;
  review(
    taskRowId: number,
    verdict: { decision: ReviewDecision; note: string; userId: number },
  ): Promise<TaskRecord>;
  clearReview(taskRowId: number): Promise<TaskRecord>;
  countsForRepos(repoIds: readonly number[]): Promise<RepoTaskCounts[]>;
}

interface TaskRow {
  id: string | number;
  repo_id: string | number;
  run_id: string;
  candidate_id: string;
  task_id: string;
  source_pr: number | null;
  source_url: string | null;
  difficulty: TaskRecord["difficulty"];
  pipeline_status: PipelineStatus;
  stage: string;
  reason: string | null;
  bundle_key: string | null;
  definition: Record<string, unknown> | null;
  review_decision: ReviewDecision | null;
  review_note: string | null;
  reviewed_by_login: string | null;
  reviewed_at: string | Date | null;
  synced_at: string | Date;
}

const SELECT = `select t.id, t.repo_id, t.run_id, t.candidate_id, t.task_id, t.source_pr, t.source_url,
  t.difficulty, t.pipeline_status, t.stage, t.reason, t.bundle_key, t.definition,
  t.review_decision, t.review_note, u.login as reviewed_by_login, t.reviewed_at, t.synced_at
  from tasks t left join users u on u.id = t.reviewed_by`;

export function createPostgresTaskStore(
  sql: SqlClient,
  options: { now?: () => Date } = {},
): TaskStore {
  const now = options.now ?? (() => new Date());
  const byId = async (id: number): Promise<TaskRecord> => {
    const [row] = await sql.query<TaskRow>(`${SELECT} where t.id = $1`, [id]);
    if (!row) throw new Error(`task ${id} vanished`);
    return taskFrom(row);
  };
  return {
    async upsertMany(rows) {
      if (rows.length === 0) return;
      await sql.transaction(async (tx) => {
        for (const row of rows) {
          await tx.query(
            `insert into tasks (repo_id, run_id, candidate_id, task_id, source_pr, source_url, difficulty,
               pipeline_status, stage, reason, bundle_key, definition, synced_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             on conflict (run_id, candidate_id) do update
               set task_id = excluded.task_id, source_pr = excluded.source_pr,
                   source_url = excluded.source_url, difficulty = excluded.difficulty,
                   pipeline_status = excluded.pipeline_status, stage = excluded.stage,
                   reason = excluded.reason, bundle_key = excluded.bundle_key,
                   definition = excluded.definition, synced_at = excluded.synced_at`,
            [
              row.repoId,
              row.runId,
              row.candidateId,
              row.taskId,
              row.sourcePr ?? null,
              row.sourceUrl ?? null,
              row.difficulty,
              row.pipelineStatus,
              row.stage,
              row.reason ?? null,
              row.bundleKey ?? null,
              row.definition ? JSON.stringify(row.definition) : null,
              now(),
            ],
          );
        }
      });
    },
    async listForRepo(repoId) {
      const rows = await sql.query<TaskRow>(
        `${SELECT} where t.repo_id = $1 order by t.run_id, t.task_id`,
        [repoId],
      );
      return rows.map(taskFrom);
    },
    async find(repoId, runId, taskOrCandidateId) {
      const rows = await sql.query<TaskRow>(
        `${SELECT} where t.repo_id = $1 and t.run_id = $2 and (t.task_id = $3 or t.candidate_id = $3)
         order by (t.task_id = $3) desc limit 1`,
        [repoId, runId, taskOrCandidateId],
      );
      return rows[0] ? taskFrom(rows[0]) : undefined;
    },
    async deleteForRun(repoId, runId) {
      const rows = await sql.query(
        "delete from tasks where repo_id = $1 and run_id = $2 returning id",
        [repoId, runId],
      );
      return rows.length;
    },
    async review(taskRowId, verdict) {
      await sql.query(
        `update tasks set review_decision = $2, review_note = $3, reviewed_by = $4, reviewed_at = $5
         where id = $1`,
        [taskRowId, verdict.decision, verdict.note, verdict.userId, now()],
      );
      return byId(taskRowId);
    },
    async clearReview(taskRowId) {
      await sql.query(
        `update tasks set review_decision = null, review_note = null, reviewed_by = null,
           reviewed_at = null where id = $1`,
        [taskRowId],
      );
      return byId(taskRowId);
    },
    async countsForRepos(repoIds) {
      if (repoIds.length === 0) return [];
      const rows = await sql.query<{
        repo_id: string | number;
        total: string | number;
        accepted: string | number;
        needs_review: string | number;
        rejected: string | number;
        last_pr: number | null;
      }>(
        `select repo_id,
           count(*) as total,
           count(*) filter (where review_decision = 'approve') as accepted,
           count(*) filter (where review_decision is null and pipeline_status = 'accepted') as needs_review,
           count(*) filter (where review_decision = 'reject'
             or (review_decision is null and pipeline_status in ('rejected', 'infrastructure_failed'))) as rejected,
           max(source_pr) as last_pr
         from tasks where repo_id = any($1::bigint[]) group by repo_id`,
        [repoIds],
      );
      return rows.map((row) => ({
        repoId: Number(row.repo_id),
        total: Number(row.total),
        accepted: Number(row.accepted),
        needsReview: Number(row.needs_review),
        rejected: Number(row.rejected),
        ...(row.last_pr !== null ? { lastPr: Number(row.last_pr) } : {}),
      }));
    },
  };
}

function taskFrom(row: TaskRow): TaskRecord {
  return {
    id: Number(row.id),
    repoId: Number(row.repo_id),
    runId: row.run_id,
    candidateId: row.candidate_id,
    taskId: row.task_id,
    ...(row.source_pr !== null ? { sourcePr: Number(row.source_pr) } : {}),
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    difficulty: row.difficulty,
    pipelineStatus: row.pipeline_status,
    stage: row.stage,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.bundle_key ? { bundleKey: row.bundle_key } : {}),
    ...(row.definition ? { definition: row.definition } : {}),
    ...(row.review_decision
      ? {
          review: {
            decision: row.review_decision,
            note: row.review_note ?? "",
            decidedBy: row.reviewed_by_login ?? "",
            decidedAt: new Date(row.reviewed_at ?? 0).toISOString(),
          },
        }
      : {}),
    syncedAt: new Date(row.synced_at).toISOString(),
  };
}
