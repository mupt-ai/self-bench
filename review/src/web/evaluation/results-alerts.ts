import { type Configuration, inProgress, type TaskResult } from "./results-model";
import {
  configurationName,
  errorMessage,
  minutesLabel,
  momentLabel,
  taskName,
} from "./results-presentation";

/**
 * What needs a look. Each rule is a banner above the table, a flag on the configuration's row,
 * and a mark on its task rows.
 */

/** A flag on a configuration's row. `task` is a task's problem, not the configuration's. */
export interface Flag {
  severity: "bad" | "warn" | "info" | "task";
  text: string;
}

export interface Alert {
  kind: "repeated-error" | "task-problem" | "stalled" | "wont-chart" | "cancelled";
  severity: "bad" | "warn" | "info";
  title: string;
  detail: string;
  /** The configuration it is about. */
  configuration?: string;
  /** The task it is about, and the configurations it errored on. */
  task?: { key: string; name: string; configurations: string[] };
}

interface Stall {
  /** Minutes since a task last finished or started. */
  idle: number;
  limit: number;
  /** The slowest finished task, when one has finished. */
  slowest?: number;
}

export interface Review {
  alerts: Alert[];
  flags: Map<string, Flag[]>;
  stalls: Map<string, Stall>;
  /** Errors that are a task's problem, by task key: the message, and how many configurations. */
  taskProblems: Map<string, { message: string; configurations: string[] }>;
}

/** How many tasks, or configurations, must share an error before it looks like one cause. */
const REPEATS = 3;
/** Before any task finishes, running tasks count as stalled after this long. */
const FIRST_FINISH_LIMIT = 90;
/** Otherwise, after this many times the slowest task the configuration finished. */
const SLOWEST_MULTIPLE = 2;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Tasks under way, and nothing finishing or starting for longer than a task should take. */
function stallOf(configuration: Configuration, now: number): Stall | undefined {
  const active = configuration.latest.filter(inProgress);
  if (!active.length) return undefined;
  const took = configuration.batches.flatMap((batch) =>
    batch.results.flatMap((result) =>
      result.trial.status === "completed" && result.minutes !== undefined ? [result.minutes] : [],
    ),
  );
  const slowest = took.length ? Math.max(...took) : undefined;
  const limit =
    slowest === undefined ? FIRST_FINISH_LIMIT : Math.max(1, slowest * SLOWEST_MULTIPLE);
  // Idle since a trial of these runs last finished or started: a start means a worker moved on.
  const runs = new Set(active.map((result) => result.run.id));
  const times = configuration.batches.flatMap((batch) =>
    batch.results.flatMap(({ run, trial }) =>
      runs.has(run.id)
        ? [trial.finishedAt, trial.startedAt].flatMap((time) => (time ? [Date.parse(time)] : []))
        : [],
    ),
  );
  const since = times.length
    ? Math.max(...times)
    : Math.min(...active.map(({ run }) => Date.parse(run.createdAt)));
  const idle = (now - since) / 60_000;
  if (!Number.isFinite(idle) || idle <= limit) return undefined;
  return { idle, limit, ...(slowest !== undefined ? { slowest } : {}) };
}

function taskProblemsOf(configurations: readonly Configuration[]) {
  const byTask = new Map<string, Map<string, string[]>>();
  for (const configuration of configurations) {
    for (const result of configuration.latest) {
      if (result.outcome !== "error") continue;
      const messages = byTask.get(result.task) ?? new Map<string, string[]>();
      byTask.set(result.task, messages);
      const message = errorMessage(result.trial.error);
      messages.set(message, [...(messages.get(message) ?? []), configuration.key]);
    }
  }
  const problems = new Map<string, { message: string; configurations: string[] }>();
  for (const [task, messages] of byTask) {
    for (const [message, keys] of messages) {
      if (keys.length >= REPEATS) problems.set(task, { message, configurations: keys });
    }
  }
  return problems;
}

/** Whether a result's error is its task's problem rather than its configuration's. */
export function isTaskProblem(review: Pick<Review, "taskProblems">, result: TaskResult): boolean {
  const problem = review.taskProblems.get(result.task);
  return (
    result.outcome === "error" &&
    !result.replacedBy &&
    problem?.message === errorMessage(result.trial.error)
  );
}

export function reviewOf(
  configurations: readonly Configuration[],
  now: number = Date.now(),
): Review {
  const review: Review = {
    alerts: [],
    flags: new Map(),
    stalls: new Map(),
    taskProblems: taskProblemsOf(configurations),
  };
  for (const configuration of configurations) {
    const name = configurationName(configuration);
    const flags: Flag[] = [];
    const own = configuration.latest.filter(
      (result) => result.outcome === "error" && !isTaskProblem(review, result),
    );
    const byMessage = new Map<string, number>();
    for (const result of own) {
      const message = errorMessage(result.trial.error);
      byMessage.set(message, (byMessage.get(message) ?? 0) + 1);
    }
    for (const [message, count] of byMessage) {
      if (count < REPEATS) continue;
      const rest = configuration.counts.running + configuration.counts.queued;
      review.alerts.push({
        kind: "repeated-error",
        severity: "bad",
        configuration: configuration.key,
        title: `${count} ${name} tasks failed with the same error`,
        detail: `“${message}”.${rest ? " The other tasks keep running." : ""}`,
      });
    }
    if (own.length) flags.push({ severity: "bad", text: plural(own.length, "Error") });
    const stall = stallOf(configuration, now);
    if (stall) {
      review.stalls.set(configuration.key, stall);
      const running = configuration.counts.running;
      const doing = running ? `${plural(running, "task")} running` : "Still preparing";
      review.alerts.push({
        kind: "stalled",
        severity: "warn",
        configuration: configuration.key,
        title: `${name} may have stalled`,
        detail:
          stall.slowest === undefined
            ? `${doing}, and nothing has finished or started in ${minutesLabel(stall.idle)}, past the ${stall.limit} min limit for a first result.`
            : `${doing}, and nothing has finished or started in ${minutesLabel(stall.idle)}; the slowest task it finished took ${minutesLabel(stall.slowest)}, so it flags past ${minutesLabel(stall.limit)}.`,
      });
      flags.push({ severity: "warn", text: "Stalled" });
    }
    const wontChart = configuration.latest.filter((result) => result.wontChart);
    if (wontChart.length) {
      const reasons = new Map<string, number>();
      for (const result of wontChart) {
        const reason = result.wontChart ?? "";
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
      const reason = [...reasons].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      review.alerts.push({
        kind: "wont-chart",
        severity: "warn",
        configuration: configuration.key,
        title: `${plural(wontChart.length, `${name} result`)} won’t chart`,
        detail: `${reason}${reasons.size > 1 ? ", among other reasons" : ""}. They stay off the chart and out of releases.`,
      });
      flags.push({ severity: "warn", text: "Won’t Chart" });
    }
    // The latest cancelled batch, though a later one may have re-run some of its tasks.
    const cancelled = configuration.batches.findLast((batch) => batch.cancelled)?.cancelled;
    if (configuration.status === "cancelled" && cancelled) {
      review.alerts.push({
        kind: "cancelled",
        severity: "info",
        configuration: configuration.key,
        title: `${name} was cancelled by ${cancelled.by}${cancelled.at ? ` on ${momentLabel(cancelled.at)}` : ""}`,
        detail: `${configuration.finished} of ${plural(configuration.latest.length, "task")} finished first; ${configuration.counts.cancelled} never finished.`,
      });
      flags.push({ severity: "info", text: "Cancelled" });
    }
    review.flags.set(configuration.key, flags);
  }
  const names = new Map(configurations.map((configuration) => [configuration.key, configuration]));
  for (const [task, problem] of review.taskProblems) {
    const taskId = task.slice(task.lastIndexOf("/") + 1);
    const affected = problem.configurations.flatMap((key) => names.get(key) ?? []);
    review.alerts.push({
      kind: "task-problem",
      severity: "bad",
      title: `${taskName(taskId)} errored on ${affected.length} configurations`,
      detail: `${affected.map(configurationName).join(", ")}, each with “${problem.message}”. Likely the task, not the models.`,
      task: { key: task, name: taskName(taskId), configurations: problem.configurations },
    });
    for (const key of problem.configurations) {
      review.flags.get(key)?.push({ severity: "task", text: taskName(taskId) });
    }
  }
  const rank = { bad: 0, warn: 1, info: 2 };
  review.alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return review;
}

/** A configuration needs attention for its own errors, a stall, or results that won't chart. */
export function needsAttention(review: Review, configuration: Configuration): boolean {
  return (review.flags.get(configuration.key) ?? []).some(
    (flag) => flag.severity === "bad" || flag.severity === "warn",
  );
}
