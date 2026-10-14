import type { EvaluationRun, EvaluationTrial } from "../types.js";
import { DARI_BILLING, responseCost } from "./billing.js";

export function isDariRun(run: EvaluationRun): boolean {
  return run.credentials?.provider === "custom" && run.modelName === "openai/dari/routing";
}

/** Use only prices returned by Dari; missing or incomplete request evidence is unknown. */
export async function dariTrialCost(
  run: EvaluationRun,
  trial: EvaluationTrial,
  _env: NodeJS.ProcessEnv,
  files: Map<string, string>,
): Promise<Pick<EvaluationTrial, "apiCostUsd" | "costSource" | "modelVerified">> {
  if (!isDariRun(run) || trial.harness !== "pi") return {};
  const bill = files.get(DARI_BILLING);
  if (bill === undefined) return {};
  const cost = responseCost(bill);
  return cost === undefined
    ? {}
    : { modelVerified: true, apiCostUsd: cost, costSource: "router-reference-rates" };
}
