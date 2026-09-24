import { MAX_CONCURRENT_CANDIDATE_WORKFLOWS } from "../../contracts/config/execution-limits.js";
import { errorMessage, settleWithLimit } from "../../lib/util.js";
import type { BatchExecutions } from "./temporal.js";
import type { BatchItem, GenerationBatch } from "./types.js";

/** Temporal RPC groups one batch sweep keeps in flight. */
const EXECUTION_CONCURRENCY = 8;
/** A running execution is described (and queried) at most this often; queries are billed. */
export const OBSERVE_INTERVAL_MS = 30_000;

const settled = (item: BatchItem) => item.result !== undefined || item.error !== undefined;

/**
 * Marks every item the next sweep may start. The caller commits this plan in its own
 * transaction before `advanceBatch`, so a crash mid-start leaves each start owned and retryable
 * under its deterministic workflow ID rather than lost or doubled.
 */
export function planBatchDispatch(batch: GenerationBatch): void {
  if (batch.phase === "discovering") {
    for (const shard of batch.shards) if (!settled(shard)) shard.dispatchAttempted = true;
    return;
  }
  if (batch.phase !== "authoring") return;
  const pending = batch.candidates.filter((item) => !settled(item));
  let room =
    MAX_CONCURRENT_CANDIDATE_WORKFLOWS - pending.filter((item) => item.dispatchAttempted).length;
  for (const item of pending) {
    if (room <= 0) break;
    if (item.dispatchAttempted) continue;
    item.dispatchAttempted = true;
    room -= 1;
  }
}

/** Runs `action` for every item concurrently; a failed RPC leaves only its own item for retry. */
async function each<T extends BatchItem>(
  batch: GenerationBatch,
  items: readonly T[],
  action: (item: T) => Promise<void>,
): Promise<void> {
  const results = await settleWithLimit(items, EXECUTION_CONCURRENCY, action);
  results.forEach((result, index) => {
    if (result.status === "rejected")
      console.error(
        `Batch ${batch.run.runId} will retry ${items[index]?.workflowId}: ${errorMessage(result.reason)}`,
      );
  });
}

function due(item: BatchItem, now: number): boolean {
  return item.observedAt === undefined || now - item.observedAt >= OBSERVE_INTERVAL_MS;
}

/**
 * One durable application sweep over every dispatched item. Items whose RPC fails keep their
 * persisted state and are retried on the next sweep; the rest of the batch still advances.
 * Once `halted` reports a pending cancel, the sweep starts nothing new, so the cancel (blocked
 * on this sweep's row lock) is not preceded by a burst of starts it must then tear down.
 */
export async function advanceBatch(
  batch: GenerationBatch,
  executions: BatchExecutions,
  now = Date.now(),
  halted: () => boolean = () => false,
): Promise<void> {
  const unstarted = (item: BatchItem) => item.observedAt === undefined && halted();
  if (batch.phase === "cancelling") {
    const all = [...batch.shards, ...batch.candidates];
    const pending = all.filter((item) => !item.result && !item.cancelled);
    await each(batch, pending, async (item) => {
      if (item.dispatchAttempted && !(await executions.cancel(item.workflowId, batch.taskQueue)))
        return;
      item.cancelled = true;
      delete item.cost;
    });
    if (all.every((item) => settled(item) || item.cancelled)) batch.phase = "cancelled";
    return;
  }
  if (batch.phase === "discovering") {
    const observed = batch.shards.filter(
      (shard) => !settled(shard) && shard.dispatchAttempted && due(shard, now),
    );
    await each(batch, observed, async (shard) => {
      if (unstarted(shard)) return;
      const snapshot = await executions.shard(shard.workflowId, shard.input, batch.taskQueue);
      shard.observedAt = now;
      if (snapshot.state === "completed") shard.result = snapshot.result;
      else if (snapshot.state === "cancelled") shard.error = "Generation cancelled.";
      else if (snapshot.state === "failed") shard.error = snapshot.error;
      else {
        if (snapshot.cost) shard.cost = snapshot.cost;
        return;
      }
      delete shard.cost;
    });
    if (!batch.shards.every(settled)) return;
    // Deterministic shard order wins duplicate PRs; no candidate is dispatched twice.
    const seen = new Set<number>();
    const ids = new Set<string>();
    for (const shard of batch.shards)
      for (const candidate of shard.result?.candidates ?? []) {
        if (seen.has(candidate.sourcePr)) continue;
        seen.add(candidate.sourcePr);
        if (ids.has(candidate.candidateId))
          throw new Error("Duplicate candidate ID across discovery shards");
        ids.add(candidate.candidateId);
        batch.candidates.push({
          workflowId: `${batch.run.runId}/candidate/${candidate.candidateId}`,
          candidate,
        });
      }
    if (!batch.candidates.length) {
      batch.phase = "failed";
      batch.error = "Discovery returned no candidates";
    } else batch.phase = "authoring";
    return; // Commit the candidate dispatch plan before starting any author workflow.
  }
  if (batch.phase !== "authoring") return;
  const observed = batch.candidates.filter(
    (item) => !settled(item) && item.dispatchAttempted && due(item, now),
  );
  const snapshots = new Map<BatchItem, Awaited<ReturnType<BatchExecutions["candidate"]>>>();
  await each(batch, observed, async (item) => {
    if (unstarted(item)) return;
    snapshots.set(
      item,
      await executions.candidate(
        item.workflowId,
        { run: batch.run, candidate: item.candidate },
        batch.taskQueue,
      ),
    );
  });
  // Results apply in candidate order so a duplicate task ID always loses to the same candidate.
  for (const item of observed) {
    const snapshot = snapshots.get(item);
    if (!snapshot) continue;
    item.observedAt = now;
    if (snapshot.state === "completed") {
      const result = snapshot.result;
      if (
        result.progress.candidateId !== item.candidate.candidateId ||
        (result.task &&
          (result.task.candidateId !== item.candidate.candidateId ||
            result.progress.status !== "accepted"))
      ) {
        console.error(
          `Batch ${batch.run.runId} rejected an inconsistent result for ${item.workflowId}`,
        );
        continue;
      }
      if (
        result.task &&
        batch.candidates.some(
          (other) => other !== item && other.result?.task?.taskId === result.task?.taskId,
        )
      ) {
        item.error = "Another candidate already owns this task ID";
      } else item.result = result;
      item.progress = result.progress;
      delete item.cost;
    } else if (snapshot.state === "cancelled") {
      item.cancelled = true;
      item.error = "Generation cancelled.";
      delete item.cost;
    } else if (snapshot.state === "failed") {
      item.error = snapshot.error;
      delete item.cost;
    } else {
      if (snapshot.progress) item.progress = snapshot.progress;
      if (snapshot.cost) item.cost = snapshot.cost;
    }
  }
  if (batch.candidates.every(settled)) batch.phase = "exporting";
}
