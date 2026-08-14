import type { EvalRun, RunMetrics, TaskResult } from "./types";

export function runMetrics(run: EvalRun): RunMetrics {
  const taskCount = run.results.length;
  const aggregate = run.results.reduce(
    (total, result) => ({
      score: total.score + result.score,
      passed: total.passed + Number(result.passed),
      cost: total.cost + result.cost_usd,
      duration: total.duration + (result.duration_ms ?? 0),
      input: total.input + (result.input_tokens ?? 0),
      output: total.output + (result.output_tokens ?? 0),
    }),
    { score: 0, passed: 0, cost: 0, duration: 0, input: 0, output: 0 },
  );
  return {
    score: taskCount ? aggregate.score / taskCount : 0,
    passRate: taskCount ? aggregate.passed / taskCount : 0,
    totalCost: aggregate.cost,
    costPerTask: taskCount ? aggregate.cost / taskCount : 0,
    passed: aggregate.passed,
    taskCount,
    durationMS: aggregate.duration,
    inputTokens: aggregate.input,
    outputTokens: aggregate.output,
  };
}

export function taskMap(run: EvalRun) {
  return new Map(run.results.map((result) => [result.task_id, result]));
}

export function taskLabel(result: TaskResult) {
  return result.task_name || result.task_id;
}

export const format = {
  percent(value: number) {
    return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(value);
  },
  dollars(value: number, compact = false) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: value < 1 ? 3 : 2,
      maximumFractionDigits: value < 1 ? 3 : 2,
      notation: compact ? "compact" : "standard",
    }).format(value);
  },
  number(value: number) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  },
  duration(milliseconds: number) {
    if (!milliseconds) return "—";
    const seconds = milliseconds / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${(seconds / 60).toFixed(1)}m`;
  },
  date(value: string) {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
  },
};
