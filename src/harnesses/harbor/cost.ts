import { record } from "../../evaluation/output.js";
import type { TokenUsage } from "../../evaluation/types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export interface HarborCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
}

/** Per-agent-request token buckets from Harbor's trajectory, or undefined if incomplete. */
export function harborCallUsage(
  trajectory: Record<string, unknown>,
  { requireCost = true }: { requireCost?: boolean } = {},
): HarborCallUsage[] | undefined {
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps.map(record) : [];
  const calls = steps.filter((step) => step.source === "agent" && step.metrics);
  if (!calls.length) return undefined;
  const usage: HarborCallUsage[] = [];
  for (const step of calls) {
    const metrics = record(step.metrics);
    const extra = record(metrics.extra);
    const prompt = metrics.prompt_tokens;
    const output = metrics.completion_tokens;
    // Harbor's Codex adapter omits cached_tokens when a call read nothing from cache.
    const cached = metrics.cached_tokens ?? 0;
    const written = extra.cache_write_input_tokens ?? 0;
    const cost = metrics.cost_usd;
    if (
      !count(prompt) ||
      !count(output) ||
      !count(cached) ||
      !count(written) ||
      (requireCost && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) ||
      cached + written > prompt
    )
      return undefined;
    usage.push({
      input: prompt - cached - written,
      output,
      cacheRead: cached,
      cacheWrite: written,
      ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
    });
  }
  return usage;
}

export function harborCost(trajectory: Record<string, unknown>, usage: TokenUsage, total: unknown) {
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return undefined;
  const calls = harborCallUsage(trajectory);
  if (!calls) return undefined;
  const sums = calls.reduce<Required<HarborCallUsage>>(
    (sum, call) => ({
      input: sum.input + call.input,
      output: sum.output + call.output,
      cacheRead: sum.cacheRead + call.cacheRead,
      cacheWrite: sum.cacheWrite + call.cacheWrite,
      cost: sum.cost + (call.cost ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
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
