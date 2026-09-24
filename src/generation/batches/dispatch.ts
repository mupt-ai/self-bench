import { MAX_CONCURRENT_CANDIDATE_WORKFLOWS } from "../../contracts/config/execution-limits.js";
import type { BatchItem, GenerationBatch } from "./types.js";

export const settled = (item: BatchItem) => item.result !== undefined || item.error !== undefined;

export interface DispatchLimits {
  /** Managed workflows running at once across the platform. */
  readonly total: number;
  /** Managed workflows one organization may run at once. */
  readonly perOrg: number;
}

function limit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]?.trim() || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Each managed workflow (discovery shard or candidate) runs at most one sandbox at a time on the
 * managed E2B account, whose plan allows 100 concurrent sandboxes.
 */
export function dispatchLimits(env: NodeJS.ProcessEnv = process.env): DispatchLimits {
  return {
    total: limit(env, "SELFBENCH_WORKFLOW_LIMIT", 100),
    perOrg: limit(env, "SELFBENCH_ORG_WORKFLOW_LIMIT", 20),
  };
}

const managedOrg = (batch: GenerationBatch) =>
  batch.run.generation?.settings.sandbox === "managed"
    ? String(batch.run.generation.orgId ?? batch.run.generation.ownerId)
    : undefined;

/** Started and not yet settled or cancelled. */
const running = (item: BatchItem) => item.dispatchAttempted && !settled(item) && !item.cancelled;

/** Items this batch would start next, in order, within its own workflow bound. */
function startable(batch: GenerationBatch): BatchItem[] {
  if (batch.phase === "discovering") return batch.shards.filter((shard) => !settled(shard));
  if (batch.phase !== "authoring") return [];
  const pending = batch.candidates.filter((item) => !settled(item));
  const room = MAX_CONCURRENT_CANDIDATE_WORKFLOWS - pending.filter(running).length;
  return pending.filter((item) => !item.dispatchAttempted).slice(0, Math.max(0, room));
}

/**
 * Marks what the next sweeps may start, first come first served across `batches` (oldest
 * first): managed work stops at `limits.total` workflows platform-wide and `limits.perOrg` per
 * organization, and waits in its batch until one finishes. The caller commits this plan before
 * `advanceBatch` runs, so a crash mid-start leaves each start owned and retryable under its
 * deterministic workflow ID rather than lost or doubled.
 */
export function planDispatch(batches: readonly GenerationBatch[], limits: DispatchLimits): void {
  let total = 0;
  const perOrg = new Map<string, number>();
  for (const batch of batches) {
    const org = managedOrg(batch);
    if (org === undefined) continue;
    const count = [...batch.shards, ...batch.candidates].filter(running).length;
    total += count;
    perOrg.set(org, (perOrg.get(org) ?? 0) + count);
  }
  for (const batch of batches) {
    const org = managedOrg(batch);
    for (const item of startable(batch)) {
      if (item.dispatchAttempted) continue;
      if (org !== undefined) {
        const held = perOrg.get(org) ?? 0;
        if (total >= limits.total || held >= limits.perOrg) break;
        total += 1;
        perOrg.set(org, held + 1);
      }
      item.dispatchAttempted = true;
    }
  }
}
