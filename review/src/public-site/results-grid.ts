import type { PublicSetting, PublicTask } from "./contract";

/** The results grid: settings down the side, tasks across, each box a setting's result on a task. */
export interface ResultsGrid {
  /** Most accurate first, then cheapest, as the settings table first sorts them. */
  settings: PublicSetting[];
  /** Solved by the most settings first, so the grid reads from easy on the left to hard. */
  tasks: (PublicTask & { passed: Record<string, boolean> })[];
}

/**
 * The grid of a release that published its trials, or undefined when its tasks carry no
 * results. A task's place among those that tie keeps the release's order.
 */
export function resultsGrid(
  settings: readonly PublicSetting[],
  tasks: readonly PublicTask[],
): ResultsGrid | undefined {
  const scored = tasks.flatMap((task) => (task.passed ? [{ ...task, passed: task.passed }] : []));
  if (scored.length === 0) return undefined;
  const solvers = (task: (typeof scored)[number]) =>
    Object.values(task.passed).filter(Boolean).length;
  return {
    settings: [...settings].sort(
      (left, right) => right.accuracy - left.accuracy || left.costPerTaskUsd - right.costPerTaskUsd,
    ),
    tasks: scored
      .map((task, index) => ({ task, index, solvers: solvers(task) }))
      .sort((left, right) => right.solvers - left.solvers || left.index - right.index)
      .map(({ task }) => task),
  };
}
