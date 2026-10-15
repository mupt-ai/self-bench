import { findModel, nativePricing } from "../contracts/models.js";
import { claudeCodeUsage } from "../harnesses/claude-code/cost.js";
import { record } from "./output.js";
import { requestsCost } from "./request-cost.js";
import type { TokenUsage } from "./types.js";

export interface MuseCodeCostMeasurement {
  modelVerified: boolean;
  tokenUsage: TokenUsage;
  apiCostUsd?: number;
}

function pricingFor(name: unknown) {
  if (typeof name !== "string") return undefined;
  const model = findModel(name.replace(/^meta\//, ""));
  return model?.vendor === "meta" ? nativePricing(model) : undefined;
}

export function measureMuseCodeCost(
  files: Map<string, string>,
  result: unknown,
): MuseCodeCostMeasurement | undefined {
  const text = [...files].find(([name]) => name.endsWith("/trajectory.json"))?.[1];
  if (!text) return undefined;
  let measured: ReturnType<typeof claudeCodeUsage>;
  try {
    measured = claudeCodeUsage(record(JSON.parse(text)), record(record(result).agent_result));
  } catch {
    return undefined;
  }
  if (!measured) return undefined;
  let apiCostUsd = 0;
  for (const request of measured.requests) {
    if (request.input + request.output + request.cacheRead + request.cacheWrite === 0) continue;
    const pricing = pricingFor(request.model);
    if (!pricing) return { modelVerified: false, tokenUsage: measured.usage };
    const cost = requestsCost(pricing, [request]);
    if (cost === undefined) return { modelVerified: true, tokenUsage: measured.usage };
    apiCostUsd += cost;
  }
  return { modelVerified: true, tokenUsage: measured.usage, apiCostUsd };
}
