import type { GenerationCost } from "../contracts.js";
import type { SandboxCostSnapshot } from "../sandbox/contracts.js";
import { generationModelPricing } from "../site/generation-models.js";
import type { RunUsageSummary } from "./usage.js";

export type CostedSandboxProvider = "docker" | "e2b" | "modal" | "vercel";

/** Combines settled ledger rows with the current activity heartbeat without inventing rates. */
export function generationCost(
  summary: RunUsageSummary,
  provider: CostedSandboxProvider | undefined,
  model: string | undefined,
  live?: SandboxCostSnapshot,
): GenerationCost {
  const sandboxSeconds = summary.sandboxSeconds + (live?.sandboxSeconds ?? 0);
  const sandboxUsd = addKnown(summary.sandboxCostUsd, live?.sandboxUsd);
  const modelUsd = addKnown(summary.modelCostUsd, live?.modelUsd);
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
    updatedAt: live?.updatedAt ?? new Date().toISOString(),
  };
}

export function sumLiveCosts(
  costs: readonly SandboxCostSnapshot[],
): SandboxCostSnapshot | undefined {
  if (!costs.length) return undefined;
  const sumKnown = (field: "sandboxUsd" | "modelUsd") =>
    costs.some((cost) => cost[field] !== undefined)
      ? costs.reduce((sum, cost) => sum + (cost[field] ?? 0), 0)
      : undefined;
  const sandboxUsd = sumKnown("sandboxUsd");
  const modelUsd = sumKnown("modelUsd");
  return {
    state: costs.every((cost) => cost.state === "estimated")
      ? "estimated"
      : costs.every((cost) => cost.state === "unknown")
        ? "unknown"
        : costs.every((cost) => cost.state === "unpriced")
          ? "unpriced"
          : "partial",
    sandboxSeconds: costs.reduce((sum, cost) => sum + cost.sandboxSeconds, 0),
    ...(sandboxUsd !== undefined ? { sandboxUsd } : {}),
    ...(modelUsd !== undefined ? { modelUsd } : {}),
    updatedAt: costs.reduce(
      (latest, cost) => (cost.updatedAt > latest ? cost.updatedAt : latest),
      costs[0]?.updatedAt ?? new Date(0).toISOString(),
    ),
  };
}

function addKnown(settled: number | undefined, live: number | undefined): number | undefined {
  if (settled === undefined && live === undefined) return undefined;
  return (settled ?? 0) + (live ?? 0);
}
