import type { EvaluationTrial } from "./types.js";

/**
 * A trial whose result can be compared: completed, the model's identity verified, a reward of
 * exactly 0 or 1, and a cost present. The Results chart and public releases count only these.
 */
export function eligibleTrial(trial: EvaluationTrial): boolean {
  const reward = trial.rewards.reward;
  const cost = trial.apiCostUsd;
  return (
    trial.status === "completed" &&
    trial.modelVerified === true &&
    (reward === 0 || reward === 1) &&
    typeof cost === "number" &&
    Number.isFinite(cost) &&
    cost >= 0
  );
}
