import type { PipelineStatus, ReviewDecision, TaskRecord } from "./task-store.js";

export interface TaskRow {
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
  workflow_id: string | null;
  started_by_login: string | null;
  started_at: string | Date | null;
  round: number | null;
}

export function taskFrom(row: TaskRow): TaskRecord {
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
    ...(row.round !== null ? { round: Number(row.round) } : {}),
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
    ...(row.workflow_id ? { workflowId: row.workflow_id } : {}),
    ...(row.started_by_login ? { startedBy: row.started_by_login } : {}),
    ...(row.started_at ? { startedAt: new Date(row.started_at).toISOString() } : {}),
  };
}
