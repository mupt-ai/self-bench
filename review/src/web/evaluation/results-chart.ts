import { eligibleTrial } from "../../../../src/evaluation/eligible";
import type { BenchmarkPoint } from "./benchmark";
import type { AcceptedTask } from "./RepoRuns";
import type { Configuration, TaskResult } from "./results-model";

/**
 * The chart's points: one per configuration, from each task's latest usable result, as a release
 * takes it, over a set of accepted tasks. A configuration is charted only when it has a usable
 * result on every task in the set, so every point covers the same tasks.
 *
 * Accepted tasks only grow, so the sets nest by when their tasks were accepted: everything
 * accepted by Sep 28, everything by Oct 1, and so on. Each set offered is the largest one some
 * group of configurations fully covers; the newest comes first, and charts the configurations
 * keeping up with every accepted task. Earlier sets chart the ones that haven't run the newer
 * tasks yet.
 */

export interface TaskSet {
  /** Task keys, `runId/taskId`. */
  tasks: string[];
  /** When the newest of them was accepted, when known. */
  acceptedBy?: string;
  /** Configurations with a usable result on every one of them. */
  configurations: Configuration[];
}

/** A configuration's usable results, by task key. */
function usableResults(configuration: Configuration): Map<string, TaskResult> {
  return new Map(
    configuration.latest
      .filter((result) => eligibleTrial(result.trial))
      .map((result) => [result.task, result]),
  );
}

/** Every task set worth charting, the newest first. */
export function taskSets(
  configurations: readonly Configuration[],
  accepted: readonly AcceptedTask[],
): TaskSet[] {
  // Oldest accepted first; a task whose acceptance time is unknown counts as among the first.
  const ordered = [...accepted].sort((a, b) =>
    (a.acceptedAt ?? "").localeCompare(b.acceptedAt ?? ""),
  );
  const keys = ordered.map((task) => `${task.runId}/${task.taskId}`);
  // A set ends where acceptance time changes: tasks accepted together go in together.
  const ends = ordered.flatMap((task, index) =>
    ordered[index + 1]?.acceptedAt === task.acceptedAt && index + 1 < ordered.length
      ? []
      : [index + 1],
  );
  // How far into the accepted tasks each configuration covers, to the end of a set.
  const reach = new Map(
    configurations.map((configuration) => {
      const usable = usableResults(configuration);
      const missing = keys.findIndex((key) => !usable.has(key));
      const covered = missing === -1 ? keys.length : missing;
      return [configuration, Math.max(0, ...ends.filter((end) => end <= covered))];
    }),
  );
  const sizes = [...new Set(reach.values())].filter((size) => size > 0).sort((a, b) => b - a);
  return sizes.map((size) => {
    const acceptedBy = ordered[size - 1]?.acceptedAt;
    return {
      tasks: keys.slice(0, size),
      ...(acceptedBy ? { acceptedBy } : {}),
      configurations: configurations.filter(
        (configuration) => (reach.get(configuration) ?? 0) >= size,
      ),
    };
  });
}

/** A configuration's point over a set it fully covers. */
export function configurationPoint(configuration: Configuration, set: TaskSet): BenchmarkPoint {
  const usable = usableResults(configuration);
  const results = set.tasks.flatMap((task) => usable.get(task) ?? []);
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
    datasetKey: String(set.tasks.length),
  };
}
