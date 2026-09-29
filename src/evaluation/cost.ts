import { harborCallUsage, harborCost } from "../harnesses/harbor/cost.js";
import { gatewayModel } from "./execution.js";
import { record } from "./output.js";
import type { EvaluationRun, EvaluationTrial, Harness, TokenUsage } from "./types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const OPENAI_MIN_CACHE_TOKENS = 1024;

/**
 * Codex ChatGPT sign-in never reports cache writes, so fresh input on a cacheable request reads
 * as plain input although the API bills it as a write. Like Dari's subscription usage adapter,
 * each such request's fresh input is attributed to writes and repriced at the saved rates.
 * "unchanged" leaves the measured usage alone; null means the records cannot support a cost.
 */
function inferSubscriptionWrites(
  trajectory: Record<string, unknown>,
  run: EvaluationRun,
  usage: TokenUsage,
): { usage: TokenUsage; costUsd: number } | "unchanged" | null {
  const pricing = run.pricing;
  // Without a write premium the buckets price identically.
  if (!pricing || pricing.cacheWrite <= pricing.input) return "unchanged";
  const calls = harborCallUsage(trajectory, { requireCost: false });
  if (!calls) return null;
  const original: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const inferred: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let changed = false;
  let costUsd = 0;
  for (const call of calls) {
    original.input += call.input;
    original.output += call.output;
    original.cacheRead += call.cacheRead;
    original.cacheWrite += call.cacheWrite;
    // The reference rates' context bound applies to each request, not the trial's sum.
    const promptTokens = call.input + call.cacheRead + call.cacheWrite;
    if (pricing.maxInputTokens && promptTokens > pricing.maxInputTokens) return null;
    let input = call.input;
    let cacheWrite = call.cacheWrite;
    // Prompts under OpenAI's cache minimum are never cached, so their fresh input stays input.
    if (cacheWrite === 0 && input > 0 && input + call.cacheRead >= OPENAI_MIN_CACHE_TOKENS) {
      cacheWrite = input;
      input = 0;
      changed = true;
    }
    inferred.input += input;
    inferred.output += call.output;
    inferred.cacheRead += call.cacheRead;
    inferred.cacheWrite += cacheWrite;
    costUsd +=
      (input * pricing.input +
        call.output * pricing.output +
        call.cacheRead * pricing.cacheRead +
        cacheWrite * pricing.cacheWrite) /
      1_000_000;
  }
  if (
    original.input !== usage.input ||
    original.output !== usage.output ||
    original.cacheRead !== usage.cacheRead ||
    original.cacheWrite !== usage.cacheWrite ||
    !Number.isFinite(costUsd)
  )
    return null;
  return changed ? { usage: inferred, costUsd } : "unchanged";
}

export function trialCost(
  run: EvaluationRun,
  harness: Harness,
  files: Map<string, string>,
  result: unknown,
  auth = run.credentials?.auth,
): Pick<
  EvaluationTrial,
  "modelVerified" | "apiCostUsd" | "tokenUsage" | "costSource" | "cacheWritesInferred"
> {
  const pricing = run.pricing;
  const model = run.modelName.split("/").slice(1).join("/");
  // Harbor records the model name the runner passed it, which is the gateway form over OpenRouter.
  const harborModel = gatewayModel(run.credentials?.provider, harness, run.modelName);
  const matches = (value: unknown) =>
    value === model || value === run.modelName || value === harborModel;
  let usage: TokenUsage | undefined;
  let verified = false;
  let reportedCost: number | undefined;
  let cacheWritesInferred = false;
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
    const totals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
      const inferred =
        auth === "codex-login" ? inferSubscriptionWrites(trajectory, run, usage) : "unchanged";
      if (inferred === null) return { modelVerified: verified, tokenUsage: usage };
      if (inferred === "unchanged") reportedCost = harborCost(trajectory, usage, tokens.cost_usd);
      else {
        usage = inferred.usage;
        reportedCost = inferred.costUsd;
        cacheWritesInferred = true;
      }
    }
  }
  const measured = {
    modelVerified: verified,
    ...(usage ? { tokenUsage: usage } : {}),
    ...(cacheWritesInferred ? { cacheWritesInferred: true } : {}),
  };
  if (!verified || !usage) return measured;
  if (reportedCost !== undefined)
    return {
      ...measured,
      apiCostUsd: reportedCost,
      costSource: cacheWritesInferred ? "reference-rates" : "harbor",
    };
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
