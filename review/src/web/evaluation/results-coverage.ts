import { eligibleTrial } from "../../../../src/evaluation/eligible";
import { unsolvedTasks } from "../../../../src/public/release-rule";
import type { AcceptedTask } from "./RepoRuns";
import type { Configuration, Outcome } from "./results-model";

/**
 * Coverage: which accepted tasks a configuration has no result for, and why, and which ones no
 * configuration passed. Imports no React, so the table, its rows and its tests share it.
 */

/** An accepted task with no result: left out of a run, or added since the last one. */
export type MissingTask = AcceptedTask & { outcome: "unrun" | "added" };

/**
 * When the configuration last ran new tasks: the start of its latest run that ran any task for
 * the first time. A re-run of tasks it already ran (its errors, say) chose those tasks, not the
 * ones it skipped, so it doesn't count.
 */
function lastNewTasksRun(configuration: Configuration): string {
  const seen = new Set<string>();
  let last = "";
  for (const batch of configuration.batches) {
    if (batch.results.some((result) => !seen.has(result.task))) last = batch.createdAt;
    for (const result of batch.results) seen.add(result.task);
  }
  return last;
}

/**
 * The accepted tasks a configuration has no result for: Added Later when accepted after it last
 * ran new tasks, so no run since could have included them; Left Out when accepted before, so that
 * run didn't. A task whose acceptance time is unknown counts as Left Out.
 */
export function missingTasks(
  configuration: Configuration,
  accepted: readonly AcceptedTask[] = [],
): MissingTask[] {
  const run = new Set(configuration.latest.map((result) => result.task));
  const since = lastNewTasksRun(configuration);
  return accepted
    .filter((task) => !run.has(`${task.runId}/${task.taskId}`))
    .map((task) => ({
      ...task,
      outcome: task.acceptedAt && task.acceptedAt > since ? "added" : "unrun",
    }));
}

/** Outcome counts with the tasks not run added in. */
export function withMissing(
  counts: Readonly<Record<Outcome, number>>,
  missing: readonly MissingTask[],
): Record<Outcome, number> {
  const all = { ...counts };
  for (const task of missing) all[task.outcome] += 1;
  return all;
}

/**
 * Accepted tasks enough configurations have a usable result for and none passed, with how many
 * ran each, by task key: their hidden tests may fail correct solutions (`unsolvedTasks`).
 */
export function unsolvedOf(
  configurations: readonly Configuration[],
  accepted: readonly AcceptedTask[] = [],
): Map<string, number> {
  const keys = new Set(accepted.map((task) => `${task.runId}/${task.taskId}`));
  return unsolvedTasks(
    configurations.map((configuration) =>
      configuration.latest
        .filter((result) => keys.has(result.task) && eligibleTrial(result.trial))
        .map((result) => [result.task, result.outcome === "passed"] as const),
    ),
  );
}
