import { record } from "./output.js";
import type { TokenUsage } from "./types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function harborCost(trajectory: Record<string, unknown>, usage: TokenUsage, total: unknown) {
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return undefined;
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps.map(record) : [];
  const calls = steps.filter((step) => step.source === "agent" && step.metrics);
  if (!calls.length) return undefined;
  const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const step of calls) {
    const metrics = record(step.metrics);
    const extra = record(metrics.extra);
    const prompt = metrics.prompt_tokens;
    const output = metrics.completion_tokens;
    const cached = metrics.cached_tokens;
    const written = extra.cache_write_input_tokens ?? 0;
    if (!count(prompt) || !count(output) || !count(cached) || !count(written)) return undefined;
    const cost = metrics.cost_usd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
    if (cached + written > prompt) return undefined;
    sums.input += prompt - cached - written;
    sums.output += output;
    sums.cacheRead += cached;
    sums.cacheWrite += written;
    sums.cost += cost;
  }
  if (
    sums.input !== usage.input ||
    sums.output !== usage.output ||
    sums.cacheRead !== usage.cacheRead ||
    sums.cacheWrite !== usage.cacheWrite ||
    Math.abs(sums.cost - total) > 1e-8
  )
    return undefined;
  return total;
}
