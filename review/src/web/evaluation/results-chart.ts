import { eligibleTrial } from "../../../../src/evaluation/eligible";
import type { BenchmarkPoint } from "./benchmark";
import type { Configuration, TaskResult } from "./results-model";

/**
 * The chart's points: one per chosen configuration, from each task's latest usable result, as a
 * release takes it, over the accepted tasks every chosen configuration has a usable result on, as
 * a release picks its tasks from the settings ticked (`taskSet` in src/public/release-rule.ts).
 * So every point covers the same tasks, and choosing fewer configurations can widen them.
 */

/** A configuration's usable results, by task key. */
function usableResults(configuration: Configuration): Map<string, TaskResult> {
  return new Map(
    configuration.latest
      .filter((result) => eligibleTrial(result.trial))
      .map((result) => [result.task, result]),
  );
}

/** The accepted tasks, by key, a configuration has a usable result on, in `accepted`'s order. */
export function coverageOf(configuration: Configuration, accepted: readonly string[]): string[] {
  const usable = usableResults(configuration);
  return accepted.filter((task) => usable.has(task));
}

/** Every accepted task all of `chosen` have a usable result on. Empty when nothing is chosen. */
export function sharedTasks(
  chosen: readonly Configuration[],
  accepted: readonly string[],
): string[] {
  if (chosen.length === 0) return [];
  const usable = chosen.map(usableResults);
  return accepted.filter((task) => usable.every((results) => results.has(task)));
}

/**
 * The configurations charted until some are chosen. Taking the ones covering the most tasks
 * first, each joins while the chart gains results by it (points times shared tasks), so one
 * configuration that ran little doesn't shrink everyone's tasks to a handful.
 */
export function defaultPicks(
  configurations: readonly Configuration[],
  accepted: readonly string[],
): Configuration[] {
  const ordered = configurations
    .map((configuration) => ({
      configuration,
      covered: coverageOf(configuration, accepted).length,
    }))
    .filter((entry) => entry.covered > 0)
    .sort((a, b) => b.covered - a.covered)
    .map((entry) => entry.configuration);
  const picks: Configuration[] = [];
  let best = 0;
  for (const configuration of ordered) {
    const next = [...picks, configuration];
    const results = next.length * sharedTasks(next, accepted).length;
    // A tie trades tasks for points; keep the tasks.
    if (results <= best) continue;
    picks.push(configuration);
    best = results;
  }
  return picks;
}

/** A configuration's point over tasks it has a usable result on every one of. */
export function configurationPoint(
  configuration: Configuration,
  tasks: readonly string[],
): BenchmarkPoint {
  const usable = usableResults(configuration);
  const results = tasks.flatMap((task) => usable.get(task) ?? []);
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    id: configuration.key,
    // Selecting the point opens the configuration's most recent run.
    runId: configuration.batches.at(-1)?.id ?? "",
    name: `${configuration.label} · ${configuration.thinking ?? "unrecorded effort"}`,
    modelLabel: configuration.label,
    provider: configuration.provider,
    model: configuration.modelName,
    thinking: configuration.thinking ?? "default",
    harness: configuration.harness,
    accuracy: mean(results.map((result) => result.trial.rewards.reward ?? 0)) * 100,
    cost: mean(results.map((result) => result.trial.apiCostUsd ?? 0)),
    tasks: results.length,
    datasetKey: String(tasks.length),
  };
}
