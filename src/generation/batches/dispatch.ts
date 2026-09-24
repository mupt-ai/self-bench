import {
  DEFAULT_WORKFLOW_LIMIT,
  MAX_CONCURRENT_CANDIDATE_WORKFLOWS,
} from "../../contracts/config/execution-limits.js";
import type { BatchItem, GenerationBatch } from "./types.js";

export const settled = (item: BatchItem) => item.result !== undefined || item.error !== undefined;

/** Managed workflows allowed to run at once across the platform. */
export function workflowLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SELFBENCH_WORKFLOW_LIMIT?.trim() || DEFAULT_WORKFLOW_LIMIT);
  if (!Number.isInteger(value) || value < 1)
    throw new Error("SELFBENCH_WORKFLOW_LIMIT must be a positive integer");
  return value;
}

const managed = (batch: GenerationBatch) => batch.run.generation?.settings.sandbox === "managed";

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
 * first): managed work stops at `limit` running workflows platform-wide and waits in its batch
 * until one finishes. The caller commits this plan before `advanceBatch` runs, so a crash
 * mid-start leaves each start owned and retryable under its deterministic workflow ID rather
 * than lost or doubled.
 */
export function planDispatch(batches: readonly GenerationBatch[], limit: number): void {
  let total = batches
    .filter(managed)
    .reduce((sum, batch) => sum + [...batch.shards, ...batch.candidates].filter(running).length, 0);
  for (const batch of batches)
    for (const item of startable(batch)) {
      if (item.dispatchAttempted) continue;
      if (managed(batch)) {
        if (total >= limit) break;
        total += 1;
      }
      item.dispatchAttempted = true;
    }
}
