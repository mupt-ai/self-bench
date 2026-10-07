import type { TokenUsage } from "../../evaluation/types.js";
import { type HarborCallUsage, harborCallUsage } from "../harbor/cost.js";

/** Anthropic bills one-hour cache writes at twice the input rate, five-minute ones at 1.25×. */
export const HOUR_CACHE_WRITE_MULTIPLIER = 2;

export interface ClaudeCodeUsage {
  usage: TokenUsage;
  /** Each request's usage, which adds up to `usage`. */
  requests: HarborCallUsage[];
  /** The part of `usage.cacheWrite` cached for an hour, which Claude sign-ins request. */
  hourCacheWrite: number;
  largestPrompt: number;
  /** The model of every request that used tokens. */
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
  const calls = harborCallUsage(trajectory);
  if (!calls) return undefined;
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let hourCacheWrite = 0;
  let largestPrompt = 0;
  for (const call of calls) {
    usage.input += call.input;
    usage.output += call.output;
    usage.cacheRead += call.cacheRead;
    usage.cacheWrite += call.cacheWrite;
    hourCacheWrite += call.hourCacheWrite;
    largestPrompt = Math.max(largestPrompt, call.input + call.cacheRead + call.cacheWrite);
  }
  if (
    totals.n_input_tokens !== usage.input + usage.cacheRead + usage.cacheWrite ||
    totals.n_output_tokens !== usage.output ||
    totals.n_cache_tokens !== usage.cacheRead
  )
    return undefined;
  return {
    usage,
    requests: calls,
    hourCacheWrite,
    largestPrompt,
    // Claude Code records an API error or interrupt as a "<synthetic>" message with no usage.
    models: calls
      .filter((call) => call.input + call.output + call.cacheRead + call.cacheWrite > 0)
      .map((call) => call.model),
  };
}
