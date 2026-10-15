import type { ModelPricing } from "../contracts/models.js";
import { codexCallUsage, type HarborCallUsage, harborCost } from "../harnesses/harbor/cost.js";
import { record } from "./output.js";
import type { RequestUsage } from "./request-cost.js";
import { requestsCost, sameUsage, sumUsage } from "./request-cost.js";
import type { EvaluationRun, TokenUsage } from "./types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const OPENAI_MIN_CACHE_TOKENS = 1024;

/**
 * Codex ChatGPT sign-in never reports cache writes, so fresh input on a cacheable request reads
 * as plain input although the API bills it as a write. Like Dari's subscription usage adapter,
 * each such request's fresh input is attributed to writes. Each request's usage as billed;
 * "unchanged" leaves the measured usage alone; null means the records cannot support a cost.
 */
function inferSubscriptionWrites(
  trajectory: Record<string, unknown>,
  run: EvaluationRun,
  usage: TokenUsage,
): HarborCallUsage[] | "unchanged" | null {
  const pricing = run.pricing;
  // Without a write premium the buckets price identically.
  if (!pricing || pricing.cacheWrite <= pricing.input) return "unchanged";
  const calls = codexCallUsage(trajectory);
  if (!calls || !sameUsage(sumUsage(calls), usage)) return null;
  let changed = false;
  const billed = calls.map((call) => {
    // Prompts under OpenAI's cache minimum are never cached, so their fresh input stays input.
    if (call.cacheWrite > 0 || call.input === 0) return call;
    if (call.input + call.cacheRead < OPENAI_MIN_CACHE_TOKENS) return call;
    changed = true;
    return { ...call, input: 0, cacheWrite: call.input };
  });
  return changed ? billed : "unchanged";
}

export interface CodexCostMeasurement {
  modelVerified: boolean;
  tokenUsage?: TokenUsage;
  requests?: readonly RequestUsage[];
  reportedCost?: number;
  cacheWritesInferred?: boolean;
  costUnavailable?: boolean;
  largestPrompt?: number;
}

export function measureCodexCost(
  run: EvaluationRun,
  files: Map<string, string>,
  result: unknown,
  auth: string | undefined,
  pricing: ModelPricing | undefined,
  matches: (value: unknown) => boolean,
): CodexCostMeasurement | undefined {
  const text = [...files].find(([name]) => name.endsWith("/trajectory.json"))?.[1];
  if (!text) return undefined;
  let trajectory: Record<string, unknown>;
  try {
    trajectory = record(JSON.parse(text));
  } catch {
    return undefined;
  }
  const steps = Array.isArray(trajectory.steps)
    ? trajectory.steps.map(record).filter((step) => step.source === "agent")
    : [];
  const modelVerified =
    steps.length > 0 &&
    steps.every((step) => matches(step.model_name ?? record(trajectory.agent).model_name));
  const tokens = record(record(result).agent_result);
  const cacheWrite =
    record(record(trajectory.final_metrics).extra).total_cache_write_input_tokens ?? 0;
  if (
    !count(tokens.n_input_tokens) ||
    !count(tokens.n_output_tokens) ||
    !count(tokens.n_cache_tokens) ||
    !count(cacheWrite) ||
    tokens.n_cache_tokens + cacheWrite > tokens.n_input_tokens
  )
    return { modelVerified };
  const calls = codexCallUsage(trajectory);
  const largestPrompt = calls
    ? Math.max(0, ...calls.map((call) => call.input + call.cacheRead + call.cacheWrite))
    : undefined;
  let usage: TokenUsage = {
    input: tokens.n_input_tokens - tokens.n_cache_tokens - cacheWrite,
    output: tokens.n_output_tokens,
    cacheRead: tokens.n_cache_tokens,
    cacheWrite,
  };
  let requests: HarborCallUsage[] | undefined =
    calls && sameUsage(sumUsage(calls), usage) ? calls : undefined;
  const billed =
    auth === "codex-login" ? inferSubscriptionWrites(trajectory, run, usage) : "unchanged";
  if (billed === null) return { modelVerified, tokenUsage: usage, costUnavailable: true };
  if (billed === "unchanged") {
    const reportedCost = harborCost(trajectory, usage, tokens.cost_usd);
    return {
      modelVerified,
      tokenUsage: usage,
      ...(requests ? { requests } : {}),
      ...(largestPrompt === undefined ? {} : { largestPrompt }),
      ...(reportedCost === undefined ? {} : { reportedCost }),
    };
  }
  const inferred = pricing && requestsCost(pricing, billed);
  if (inferred === undefined) return { modelVerified, tokenUsage: usage };
  usage = sumUsage(billed);
  requests = billed;
  return {
    modelVerified,
    tokenUsage: usage,
    ...(requests ? { requests } : {}),
    reportedCost: inferred,
    cacheWritesInferred: true,
    ...(largestPrompt === undefined ? {} : { largestPrompt }),
  };
}
