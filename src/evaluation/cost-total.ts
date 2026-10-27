import type { EvaluationTrial } from "./types.js";

/** A cost per task, or "Not Available" when no task had a price. */
export function knownCostLabel(
  value: number | undefined,
  format: (value: number) => string,
  known?: number,
): string {
  return value === undefined || known === 0 ? "Not Available" : format(value);
}

/** The priced trials' spend; a trial without a price counts as their mean, not as free. */
export function costTotal(trials: readonly Pick<EvaluationTrial, "apiCostUsd">[]) {
  const priced = trials.filter((trial) => trial.apiCostUsd !== undefined);
  const total = priced.reduce((sum, trial) => sum + (trial.apiCostUsd ?? 0), 0);
  return {
    total,
    known: priced.length,
    ...(priced.length ? { perTask: total / priced.length } : {}),
  };
}
