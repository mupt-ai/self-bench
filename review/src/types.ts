export type ModelResult = 'pass' | 'fail' | 'missing' | 'unreadable' | 'stale';
export type Verdict = 'accepted' | 'needs_review' | 'rejected';
export type ReviewStatus = 'unreviewed' | 'in_review' | 'approved' | 'changes_requested' | 'rejected';

export interface Quality {
  review_notes?: string;
  reviewed_warnings?: string[];
  review_status?: ReviewStatus;
}

export interface TaskSummary {
  task_id: string;
  repo: string;
  workdir: string;
  source_pr: number | null;
  source_url: string | null;
  validation: string;
  verdict: Verdict;
  solver_signal: string;
  model_results: Record<string, ModelResult>;
  blockers: string[];
  warnings: string[];
  quality: Quality;
  review_status: ReviewStatus;
  fail_to_pass_count: number;
  pass_to_pass_count: number;
}

export interface Summaries {
  models: string[];
  counts: Partial<Record<Verdict, number>>;
  review_counts: Partial<Record<ReviewStatus, number>>;
  tasks: TaskSummary[];
}

export interface PromptOrigin {
  kind: 'prompt.md' | 'agent_json';
  path: string;
  format?: string;
  message_index?: number;
}

export interface SourceTraceMessage {
  role: 'user' | 'assistant';
  content: string;
  user_message_index?: number;
}

export interface SourceTrace {
  origin: {
    path: string;
    format: string;
  };
  messages: SourceTraceMessage[];
}

export interface RunDetail {
  exists: boolean;
  prompt_status: 'current' | 'stale' | 'untracked';
  stale_reason: string | null;
  result: Record<string, unknown> | null;
  result_text: string;
  agent_patch: string;
}

export interface TaskDetail {
  summary: TaskSummary;
  task_json_text: string;
  prompt: string;
  prompt_origin: PromptOrigin;
  source_trace: SourceTrace | null;
  validation_result: Record<string, unknown> | null;
  validation_text: string;
  runs: Record<string, RunDetail>;
}
