import { codexCallUsage } from "../src/harnesses/harbor/cost.js";
import { requestsCost } from "../src/evaluation/request-cost.js";
import type { EvaluationRun, EvaluationTrial } from "../src/evaluation/types.js";

/** Complete objects from the beginning of a cut JSON steps array, never a guessed JSON repair. */
export function prefixSteps(text: string): Record<string, unknown>[] {
  const start = /"steps"\s*:\s*\[/.exec(text);
  if (!start || !text.trimStart().startsWith("{")) return [];
  const steps: Record<string, unknown>[] = [];
  let depth = 0, quoted = false, escaped = false, begin = -1;
  for (let i = start.index + start[0].length; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (depth === 0 && c === "]") break;
    if (c === "{") { if (depth++ === 0) begin = i; }
    else if (c === "}" && --depth === 0 && begin >= 0) {
      try { steps.push(JSON.parse(text.slice(begin, i + 1))); } catch { return []; }
    }
  }
  return steps;
}

/** Saved complete request metrics support a subtotal, not the unseen rest of a trajectory. */
export function partialCodexCost(run: EvaluationRun, trial: EvaluationTrial, text: string,
  auth: "codex-login" | "api-key" | undefined): Pick<EvaluationTrial, "apiCostUsd" | "costSource" | "costIncomplete"> | undefined {
  if (trial.harness !== "codex" || run.credentials?.provider !== "openai" ||
      !run.pricing || !auth || trial.modelVerified !== true) return undefined;
  const steps = prefixSteps(text);
  if (steps.some(step => step.source === "agent" && step.model_name && step.model_name !== run.modelName &&
      step.model_name !== run.modelName.slice("openai/".length))) return undefined;
  const calls = codexCallUsage({ steps });
  if (!calls?.length) return undefined;
  const usage = calls.map(call => auth === "codex-login" && run.pricing!.cacheWrite > run.pricing!.input &&
    call.cacheWrite === 0 && call.input + call.cacheRead >= 1024
      ? { ...call, cacheWrite: call.input, input: 0 } : call);
  const cost = requestsCost(run.pricing, usage);
  return cost !== undefined && cost > 0
    ? { apiCostUsd: cost, costSource: "reference-rates", costIncomplete: true }
    : undefined;
}
