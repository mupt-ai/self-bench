import type { GenerationCost } from "../contracts/index.js";
import { generationModelPricing } from "../generation/models.js";
import type { SandboxCostSnapshot } from "../sandbox/contracts.js";
import type { RunUsageSummary } from "./usage.js";

export type CostedSandboxProvider = "docker" | "e2b" | "modal" | "vercel";

/** Combines settled ledger rows with heartbeats that have not already reached the ledger. */
export function generationCost(
  summary: RunUsageSummary,
  provider: CostedSandboxProvider | undefined,
  model: string | undefined,
  live?: SandboxCostSnapshot | readonly SandboxCostSnapshot[],
): GenerationCost {
  const pending = liveCostsAfterSettlement(summary, live);
  const sandboxSeconds =
    summary.sandboxSeconds + pending.reduce((sum, cost) => sum + cost.sandboxSeconds, 0);
  const sandboxUsd = addKnown(summary.sandboxCostUsd, sumKnown(pending, "sandboxUsd"));
  const modelUsd = addKnown(summary.modelCostUsd, sumKnown(pending, "modelUsd"));
  const sandboxPriced = provider === "e2b";
  const modelPriced = model !== undefined && generationModelPricing(model) !== undefined;
  const state =
    provider === undefined
      ? "unknown"
      : sandboxPriced && modelPriced
        ? "estimated"
        : sandboxPriced || modelPriced
          ? "partial"
          : "unpriced";
  return {
    state,
    ...(state === "estimated" ? { usd: (sandboxUsd ?? 0) + (modelUsd ?? 0) } : {}),
    ...(sandboxUsd !== undefined ? { sandboxUsd } : {}),
    ...(modelUsd !== undefined ? { modelUsd } : {}),
    sandboxSeconds,
    updatedAt: latestTimestamp(pending) ?? new Date().toISOString(),
  };
}

function liveCostsAfterSettlement(
  summary: RunUsageSummary,
  live: SandboxCostSnapshot | readonly SandboxCostSnapshot[] | undefined,
): readonly SandboxCostSnapshot[] {
  const costs = live ? (Array.isArray(live) ? live : [live]) : [];
  const settled = new Set(summary.settledStages);
  return costs.filter((cost) => !settled.has(cost.stage));
}

function sumKnown(
  costs: readonly SandboxCostSnapshot[],
  field: "sandboxUsd" | "modelUsd",
): number | undefined {
  return costs.some((cost) => cost[field] !== undefined)
    ? costs.reduce((sum, cost) => sum + (cost[field] ?? 0), 0)
    : undefined;
}

function latestTimestamp(costs: readonly SandboxCostSnapshot[]): string | undefined {
  return costs.reduce<string | undefined>(
    (latest, cost) => (!latest || cost.updatedAt > latest ? cost.updatedAt : latest),
    undefined,
  );
}

function addKnown(settled: number | undefined, live: number | undefined): number | undefined {
  if (settled === undefined && live === undefined) return undefined;
  return (settled ?? 0) + (live ?? 0);
}
