import { record } from "../../evaluation/output.js";
import type { TokenUsage } from "../../evaluation/types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Anthropic bills one-hour cache writes at twice the input rate, five-minute ones at 1.25×. */
export const HOUR_CACHE_WRITE_MULTIPLIER = 2;

export interface ClaudeCodeUsage {
  usage: TokenUsage;
  /** The part of `usage.cacheWrite` cached for an hour, which Claude sign-ins request. */
  hourCacheWrite: number;
  largestPrompt: number;
  models: unknown[];
}

/**
 * Token buckets from Harbor's Claude Code trajectory, or undefined unless every request's are
 * whole and they add up to the totals Harbor reports, so no request goes unpriced. Harbor's own
 * per-request costs price every write as a five-minute one, so they are not used.
 */
export function claudeCodeUsage(
  trajectory: Record<string, unknown>,
  totals: Record<string, unknown>,
): ClaudeCodeUsage | undefined {
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps.map(record) : [];
  const calls = steps.filter((step) => step.source === "agent" && step.metrics);
  if (!calls.length) return undefined;
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let prompts = 0;
  let hourCacheWrite = 0;
  let largestPrompt = 0;
  for (const step of calls) {
    const metrics = record(step.metrics);
    const extra = record(metrics.extra);
    const prompt = metrics.prompt_tokens;
    const output = metrics.completion_tokens;
    const cached = metrics.cached_tokens ?? 0;
    const written = extra.cache_creation_input_tokens ?? 0;
    const hour = record(extra.cache_creation).ephemeral_1h_input_tokens ?? 0;
    if (
      !count(prompt) ||
      !count(output) ||
      !count(cached) ||
      !count(written) ||
      !count(hour) ||
      hour > written ||
      cached + written > prompt
    )
      return undefined;
    usage.input += prompt - cached - written;
    usage.output += output;
    usage.cacheRead += cached;
    usage.cacheWrite += written;
    hourCacheWrite += hour;
    prompts += prompt;
    largestPrompt = Math.max(largestPrompt, prompt);
  }
  if (
    totals.n_input_tokens !== prompts ||
    totals.n_output_tokens !== usage.output ||
    totals.n_cache_tokens !== usage.cacheRead
  )
    return undefined;
  return {
    usage,
    hourCacheWrite,
    largestPrompt,
    models: calls.map((step) => step.model_name),
  };
}
