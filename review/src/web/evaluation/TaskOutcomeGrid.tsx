import { ResultsMatrix, type ResultsMatrixCell, type ResultsMatrixRow } from "../ResultsMatrix";
import type { Configuration, TaskResult } from "./results-model";
import { configurationColor, configurationDetail } from "./results-presentation";

export interface OutcomeGridTask {
  key: string;
  /** The batch the task came from, for its page. */
  runId: string;
  id: string;
}

/** A task's pull request number, for ordering and its column heading. */
const prNumber = (taskId: string) => /(?:^|-)pr-(\d+)/.exec(taskId)?.[1];

export function outcomeGridTasks(configurations: readonly Configuration[]): OutcomeGridTask[] {
  const tasks = new Map<string, OutcomeGridTask>();
  for (const configuration of configurations) {
    for (const batch of configuration.batches) {
      for (const result of batch.results) {
        if (!tasks.has(result.task))
          tasks.set(result.task, {
            key: result.task,
            runId: result.trial.runId,
            id: result.trial.taskId,
          });
      }
    }
  }
  // By pull request number, as a run's task list orders them, then by id.
  const order = (task: OutcomeGridTask) => Number(prNumber(task.id) ?? Number.POSITIVE_INFINITY);
  return [...tasks.values()].sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
}

/** A configuration's attempts at a task, oldest first. */
function attemptsAt(configuration: Configuration, taskKey: string): TaskResult[] {
  return configuration.batches
    .flatMap((batch) => batch.results.filter((result) => result.task === taskKey))
    .sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));
}

function cellOf(attempts: readonly TaskResult[]): ResultsMatrixCell | undefined {
  if (!attempts.length) return undefined;
  const count = (outcome: TaskResult["outcome"]) =>
    attempts.filter((result) => result.outcome === outcome).length;
  const passed = count("passed");
  const failed = count("failed");
  const errored = count("error");
  return { passed, failed, errored, other: attempts.length - passed - failed - errored };
}

/**
 * The attempt a box opens: the latest failure, since that is the one worth explaining, else the
 * latest pass, else the latest attempt of any kind.
 */
function attemptToOpen(attempts: readonly TaskResult[]): TaskResult | undefined {
  const latest = (outcome: TaskResult["outcome"]) =>
    attempts.findLast((result) => result.outcome === outcome);
  return latest("failed") ?? latest("passed") ?? attempts.at(-1);
}

/** Every configuration's attempts at every task, one box each, shaded by how many passed. */
export function TaskOutcomeGrid({
  configurations,
  tasks,
  onOpenTask,
  onOpenAudit,
}: {
  configurations: readonly Configuration[];
  tasks: readonly OutcomeGridTask[];
  onOpenTask(result: TaskResult): void;
  /** Opens a task's own dialog, from its column's tick. */
  onOpenAudit(task: OutcomeGridTask): void;
}) {
  if (!tasks.length) return null;
  const attempts = new Map(
    configurations.map((configuration) => [
      configuration.key,
      new Map(tasks.map((task) => [task.key, attemptsAt(configuration, task.key)])),
    ]),
  );
  const rows: ResultsMatrixRow[] = configurations.map((configuration) => ({
    id: configuration.key,
    label: configuration.label,
    detail: configurationDetail(configuration),
    color: configurationColor(configuration),
  }));

  return (
    <ResultsMatrix
      titled={false}
      rows={rows}
      tasks={tasks.map((task) => {
        const number = prNumber(task.id);
        return { id: task.key, label: task.id, head: number ? `#${number}` : task.id };
      })}
      empty="cross"
      renderHead={({ task: { id }, className, children }) => {
        const task = tasks.find((entry) => entry.key === id);
        if (!task) return null;
        return (
          <button
            type="button"
            aria-label={`Audit ${task.id}`}
            className={`cursor-pointer ${className}`}
            onClick={() => onOpenAudit(task)}
          >
            {children}
          </button>
        );
      }}
      cell={(configurationKey, taskKey) =>
        cellOf(attempts.get(configurationKey)?.get(taskKey) ?? [])
      }
      renderBox={({ rowId, task, className, label, children }) => {
        const result = attemptToOpen(attempts.get(rowId)?.get(task.id) ?? []);
        return (
          <button
            type="button"
            aria-label={label}
            title={label}
            className={`cursor-pointer ${className}`}
            onClick={() => result && onOpenTask(result)}
          >
            {children}
          </button>
        );
      }}
    />
  );
}
