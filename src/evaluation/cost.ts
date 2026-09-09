import { harborCost } from "./harbor-cost.js";
import { record } from "./output.js";
import type { EvaluationRun, EvaluationTrial } from "./types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function trialCost(
  run: EvaluationRun,
  harness: string,
  files: Map<string, string>,
  result: unknown,
): Pick<EvaluationTrial, "modelVerified" | "apiCostUsd" | "tokenUsage" | "costSource"> {
  const pricing = run.pricing;
  const model = run.modelName.split("/").slice(1).join("/");
  const matches = (value: unknown) => value === model || value === run.modelName;
  let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
  let verified = false;
  let reportedCost: number | undefined;
  if (harness === "pi") {
    const text = [...files].find(([name]) => name.endsWith("/pi.txt"))?.[1];
    if (!text) return {};
    const messages: Record<string, unknown>[] = [];
    for (const line of text.split("\n").filter(Boolean)) {
      let event: Record<string, unknown>;
      try {
        event = record(JSON.parse(line));
      } catch {
        return {};
      }
      const message = record(event.message);
      if (event.type === "message_end" && message.role === "assistant") messages.push(message);
    }
    verified =
      messages.length > 0 &&
      messages.every((message) => `${message.provider}/${message.model}` === run.modelName);
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const message of messages) {
      const tokens = record(message.usage);
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const value = tokens[key];
        if (!count(value)) return { modelVerified: verified };
        totals[key] += value;
      }
    }
    usage = totals;
  } else if (harness === "codex") {
    const text = [...files].find(([name]) => name.endsWith("/trajectory.json"))?.[1];
    if (!text) return {};
    let trajectory: Record<string, unknown>;
    try {
      trajectory = record(JSON.parse(text));
    } catch {
      return {};
    }
    const steps = Array.isArray(trajectory.steps)
      ? trajectory.steps.map(record).filter((step) => step.source === "agent")
      : [];
    verified =
      steps.length > 0 &&
      steps.every((step) => matches(step.model_name ?? record(trajectory.agent).model_name));
    const tokens = record(record(result).agent_result);
    const cacheWrite =
      record(record(trajectory.final_metrics).extra).total_cache_write_input_tokens ?? 0;
    if (
      count(tokens.n_input_tokens) &&
      count(tokens.n_output_tokens) &&
      count(tokens.n_cache_tokens) &&
      count(cacheWrite) &&
      tokens.n_cache_tokens + cacheWrite <= tokens.n_input_tokens
    ) {
      usage = {
        input: tokens.n_input_tokens - tokens.n_cache_tokens - cacheWrite,
        output: tokens.n_output_tokens,
        cacheRead: tokens.n_cache_tokens,
        cacheWrite,
      };
      reportedCost = harborCost(trajectory, usage, tokens.cost_usd);
    }
  }
  const measured = { modelVerified: verified, ...(usage ? { tokenUsage: usage } : {}) };
  if (!verified || !usage) return measured;
  if (reportedCost !== undefined)
    return { ...measured, apiCostUsd: reportedCost, costSource: "harbor" };
  if (!pricing) return measured;
  if (
    pricing.maxInputTokens &&
    usage.input + usage.cacheRead + usage.cacheWrite > pricing.maxInputTokens
  )
    return measured;
  const apiCostUsd =
    (usage.input * pricing.input +
      usage.output * pricing.output +
      usage.cacheRead * pricing.cacheRead +
      usage.cacheWrite * pricing.cacheWrite) /
    1_000_000;
  return Number.isFinite(apiCostUsd)
    ? { ...measured, apiCostUsd, costSource: "reference-rates" }
    : measured;
}
