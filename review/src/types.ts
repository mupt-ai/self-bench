export type ModelResult = 'pass' | 'fail' | 'missing' | 'unreadable';
export type Verdict = 'accepted' | 'needs_review' | 'rejected';

export interface Quality {
  review_notes?: string;
  reviewed_warnings?: string[];
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
  fail_to_pass_count: number;
  pass_to_pass_count: number;
}

export interface Summaries {
  models: string[];
  counts: Partial<Record<Verdict, number>>;
  tasks: TaskSummary[];
}

export interface PromptOrigin {
  kind: 'prompt.md' | 'agent_json';
  path: string;
  format?: string;
  message_index?: number;
}

export interface RunDetail {
  exists: boolean;
  result: Record<string, unknown> | null;
  result_text: string;
  agent_patch: string;
}

export interface TaskDetail {
  summary: TaskSummary;
  task_json: Record<string, unknown>;
  task_json_text: string;
  prompt: string;
  prompt_origin: PromptOrigin;
  validation_result: Record<string, unknown> | null;
  validation_text: string;
  runs: Record<string, RunDetail>;
}
