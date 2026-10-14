export function knownCostLabel(
  value: number | undefined,
  incomplete: boolean | undefined,
  format: (value: number) => string,
  known?: number,
): string {
  if (value === undefined || known === 0) return "Not Available";
  return `${format(value)}${incomplete ? " (Incomplete)" : ""}`;
}

import type { EvaluationTrial } from "./types.js";

/** Known spend is a lower bound whenever any contributing trial is unpriced or incomplete. */
export function costTotal(
  trials: readonly Pick<EvaluationTrial, "apiCostUsd" | "costIncomplete">[],
) {
  const priced = trials.filter((trial) => trial.apiCostUsd !== undefined);
  return {
    total: priced.reduce((sum, trial) => sum + (trial.apiCostUsd ?? 0), 0),
    known: priced.length,
    incomplete: priced.length !== trials.length || trials.some((trial) => trial.costIncomplete),
  };
}
