import { costTotal } from "../../../../src/evaluation/cost-total";
import { eligibleTrial } from "../../../../src/evaluation/eligible";
import type { BenchmarkPoint } from "./benchmark";
import type { Configuration, TaskResult } from "./results-model";

/**
 * The chart's points: one per chosen configuration, from each task's latest usable result, as a
 * release takes it, over the accepted tasks every chosen configuration has a usable result on, as
 * a release picks its tasks from the settings ticked (`taskSet` in src/public/release-rule.ts). So every point covers the same
 * tasks, and choosing fewer configurations can widen them.
 */

/** A configuration the chart can plot, and the accepted tasks, by key, it has a usable result on. */
export interface ChartOption {
  configuration: Configuration;
  coverage: Set<string>;
}

/** A configuration's usable results, by task key. */
function usableResults(configuration: Configuration): Map<string, TaskResult> {
  return new Map(
    configuration.latest
      .filter((result) => eligibleTrial(result.trial))
      .map((result) => [result.task, result]),
  );
}

/** The configurations with a usable result on some accepted task. */
export function chartOptions(
  configurations: readonly Configuration[],
  accepted: readonly string[],
): ChartOption[] {
  return configurations.flatMap((configuration) => {
    const usable = usableResults(configuration);
    const coverage = new Set(accepted.filter((task) => usable.has(task)));
    return coverage.size ? [{ configuration, coverage }] : [];
  });
}

/**
 * The options charted until some are chosen: of the groups made of one option and every option
 * covering its tasks, the one with the most results (points times tasks), more tasks winning a
 * tie. So one configuration that ran little doesn't shrink everyone's tasks to a handful, and one
 * that ran everything doesn't chart alone.
 */
function defaultPicks(options: readonly ChartOption[]): ChartOption[] {
  let best: { group: ChartOption[]; tasks: number } = { group: [], tasks: 0 };
  for (const seed of options) {
    const group = options.filter((option) =>
      [...seed.coverage].every((task) => option.coverage.has(task)),
    );
    const tasks = seed.coverage.size;
    const results = group.length * tasks;
    const bestResults = best.group.length * best.tasks;
    if (results > bestResults || (results === bestResults && tasks > best.tasks))
      best = { group, tasks };
  }
  return best.group;
}

/**
 * The options to chart, in the order offered: the saved choice's that are still offered, or the
 * default when nothing was saved or none of it is offered anymore. Clearing every box is saved
 * as a choice, and charts nothing.
 */
export function chosenOptions(
  options: readonly ChartOption[],
  saved: readonly string[] | undefined,
): ChartOption[] {
  const keys = new Set(saved);
  const kept = options.filter((option) => keys.has(option.configuration.key));
  if (saved && (kept.length || !saved.length)) return kept;
  return defaultPicks(options);
}

/** A configuration's point over tasks it has a usable result on every one of. */
export function configurationPoint(
  configuration: Configuration,
  tasks: readonly string[],
): BenchmarkPoint | undefined {
  const usable = usableResults(configuration);
  const results = tasks.flatMap((task) => usable.get(task) ?? []);
  const cost = costTotal(results.map((result) => result.trial)).perTask;
  if (!results.length || cost === undefined) return undefined;
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
    cost,
    tasks: results.length,
    datasetKey: String(tasks.length),
  };
}
