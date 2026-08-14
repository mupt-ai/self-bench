export type TaskResult = {
  task_id: string;
  task_name: string;
  passed: boolean;
  score: number;
  cost_usd: number;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
};

export type EvalRun = {
  id: string;
  name: string;
  model: string;
  provider: string;
  harness: string;
  thinking_level: string;
  started_at?: string;
  results: TaskResult[];
};

export type Evaluation = {
  id: string;
  name: string;
  description?: string;
  benchmark: string;
  uploaded_at: string;
  source_file?: string;
  runs: EvalRun[];
};

export type EvaluationSummary = {
  id: string;
  name: string;
  description?: string;
  benchmark: string;
  uploaded_at: string;
  run_count: number;
  task_count: number;
  best_score: number;
  total_cost_usd: number;
};

export type RunMetrics = {
  score: number;
  passRate: number;
  totalCost: number;
  costPerTask: number;
  passed: number;
  taskCount: number;
  durationMS: number;
  inputTokens: number;
  outputTokens: number;
};
