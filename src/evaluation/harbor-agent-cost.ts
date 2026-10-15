import { harborCost } from "../harnesses/harbor/cost.js";
import { record } from "./output.js";
import { type RequestUsage, sameUsage, sumUsage } from "./request-cost.js";
import type { TokenUsage } from "./types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export interface HarborAgentCostMeasurement {
  modelVerified: boolean;
  tokenUsage?: TokenUsage;
  requests?: readonly RequestUsage[];
  reportedCost?: number;
  /** False when cache writes are not recorded separately from ordinary input. */
  referenceRatesComplete?: boolean;
}

/** Measures Harbor's Mini-SWE-Agent and Terminus 2 ATIF output. */
export function measureHarborAgentCost(
  files: Map<string, string>,
  result: unknown,
  matches: (value: unknown) => boolean,
): HarborAgentCostMeasurement | undefined {
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
  const totals = record(record(result).agent_result);
  if (
    !count(totals.n_input_tokens) ||
    !count(totals.n_cache_tokens) ||
    !count(totals.n_output_tokens) ||
    totals.n_cache_tokens > totals.n_input_tokens
  )
    return { modelVerified };

  let cacheWritesObserved = true;
  const calls = steps.map((step): RequestUsage | undefined => {
    const metrics = record(step.metrics);
    const extra = record(metrics.extra);
    const stepExtra = record(step.extra);
    const details = record(extra.prompt_tokens_details ?? stepExtra.prompt_tokens_details);
    if (!count(metrics.prompt_tokens) || !count(metrics.completion_tokens)) return undefined;
    const cached = metrics.cached_tokens ?? details.cached_tokens ?? 0;
    const reportedWrites =
      extra.cache_write_input_tokens ??
      extra.cache_creation_input_tokens ??
      details.cache_creation_tokens;
    const written = reportedWrites ?? 0;
    if (reportedWrites === undefined) cacheWritesObserved = false;
    if (!count(cached) || !count(written) || cached + written > metrics.prompt_tokens)
      return undefined;
    return {
      input: metrics.prompt_tokens - cached - written,
      output: metrics.completion_tokens,
      cacheRead: cached,
      cacheWrite: written,
    };
  });
  const writes = calls.every((call): call is RequestUsage => call !== undefined)
    ? calls.reduce((sum, call) => sum + call.cacheWrite, 0)
    : undefined;
  if (writes === undefined || writes > totals.n_input_tokens - totals.n_cache_tokens)
    return { modelVerified };
  const usage: TokenUsage = {
    input: totals.n_input_tokens - totals.n_cache_tokens - writes,
    output: totals.n_output_tokens,
    cacheRead: totals.n_cache_tokens,
    cacheWrite: writes,
  };
  const requests =
    calls.every((call): call is RequestUsage => call !== undefined) &&
    sameUsage(sumUsage(calls), usage)
      ? calls
      : undefined;
  const largestPrompt = requests
    ? Math.max(0, ...requests.map((call) => call.input + call.cacheRead))
    : undefined;
  const reportedCost = harborCost(trajectory, usage, totals.cost_usd);
  return {
    modelVerified,
    tokenUsage: usage,
    ...(requests ? { requests } : {}),
    ...(largestPrompt === undefined ? {} : { largestPrompt }),
    ...(reportedCost === undefined ? {} : { reportedCost }),
    referenceRatesComplete: cacheWritesObserved,
  };
}
