import { claudeCodeUsage } from "../harnesses/claude-code/cost.js";
import { record } from "./output.js";
import type { RequestUsage } from "./request-cost.js";
import type { TokenUsage } from "./types.js";

export interface ClaudeCodeCostMeasurement {
  modelVerified: boolean;
  tokenUsage: TokenUsage;
  requests: readonly RequestUsage[];
  largestPrompt: number;
  hourCacheWrite: number;
}

export function measureClaudeCodeCost(
  files: Map<string, string>,
  result: unknown,
  matches: (value: unknown) => boolean,
): ClaudeCodeCostMeasurement | undefined {
  const text = [...files].find(([name]) => name.endsWith("/trajectory.json"))?.[1];
  if (!text) return undefined;
  let measured: ReturnType<typeof claudeCodeUsage>;
  try {
    measured = claudeCodeUsage(record(JSON.parse(text)), record(record(result).agent_result));
  } catch {
    return undefined;
  }
  if (!measured) return undefined;
  return {
    modelVerified: measured.models.every(matches),
    tokenUsage: measured.usage,
    requests: measured.requests,
    largestPrompt: measured.largestPrompt,
    hourCacheWrite: measured.hourCacheWrite,
  };
}
