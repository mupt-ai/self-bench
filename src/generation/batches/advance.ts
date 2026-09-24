import type { CandidateWorkflowResult } from "../../contracts/index.js";
import { errorMessage, settleWithLimit } from "../../lib/util.js";
import { settled } from "./dispatch.js";
import type { BatchExecutions } from "./temporal.js";
import type { BatchItem, GenerationBatch } from "./types.js";

/** Temporal RPC groups one batch sweep keeps in flight. */
const EXECUTION_CONCURRENCY = 8;
/** A running execution is described (and queried) at most this often; queries are billed. */
export const OBSERVE_INTERVAL_MS = 30_000;

type Candidate = GenerationBatch["candidates"][number];
type CandidateSnapshot = Awaited<ReturnType<BatchExecutions["candidate"]>>;

interface Sweep {
  readonly batch: GenerationBatch;
  readonly executions: BatchExecutions;
  readonly now: number;
  /** True once a cancel is pending; the sweep then starts nothing new. */
  readonly halted: () => boolean;
}

/** Dispatched, unsettled, and not observed within the interval. */
const due = (item: BatchItem, now: number) =>
  !settled(item) &&
  item.dispatchAttempted === true &&
  (item.observedAt === undefined || now - item.observedAt >= OBSERVE_INTERVAL_MS);

/** An item never observed has not been started by this batch yet. */
const mayStart = (sweep: Sweep, item: BatchItem) =>
  item.observedAt !== undefined || !sweep.halted();

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
  const sweep: Sweep = { batch, executions, now, halted };
  if (batch.phase === "cancelling") await cancelBatch(sweep);
  else if (batch.phase === "discovering") await advanceDiscovery(sweep);
  else if (batch.phase === "authoring") await advanceAuthoring(sweep);
}

/** Runs `action` for every item concurrently; a failed RPC leaves only its own item for retry. */
async function each<T extends BatchItem>(
  sweep: Sweep,
  items: readonly T[],
  action: (item: T) => Promise<void>,
): Promise<void> {
  const results = await settleWithLimit(items, EXECUTION_CONCURRENCY, action);
  results.forEach((result, index) => {
    if (result.status === "rejected")
      console.error(
        `Batch ${sweep.batch.run.runId} will retry ${items[index]?.workflowId}: ${errorMessage(result.reason)}`,
      );
  });
}

async function cancelBatch(sweep: Sweep): Promise<void> {
  const { batch, executions } = sweep;
  const all = [...batch.shards, ...batch.candidates];
  const pending = all.filter((item) => !item.result && !item.cancelled);
  await each(sweep, pending, async (item) => {
    if (item.dispatchAttempted && !(await executions.cancel(item.workflowId, batch.taskQueue)))
      return;
    item.cancelled = true;
    delete item.cost;
  });
  if (all.every((item) => settled(item) || item.cancelled)) batch.phase = "cancelled";
}

async function advanceDiscovery(sweep: Sweep): Promise<void> {
  const { batch, executions, now } = sweep;
  const observed = batch.shards.filter((shard) => due(shard, now));
  await each(sweep, observed, async (shard) => {
    if (!mayStart(sweep, shard)) return;
    const snapshot = await executions.shard(shard.workflowId, shard.input, batch.taskQueue);
    shard.observedAt = now;
    if (snapshot.state === "running") {
      if (snapshot.cost) shard.cost = snapshot.cost;
      return;
    }
    if (snapshot.state === "completed") shard.result = snapshot.result;
    else shard.error = snapshot.state === "failed" ? snapshot.error : "Generation cancelled.";
    delete shard.cost;
  });
  if (batch.shards.every(settled)) planCandidates(batch);
}

/**
 * Deterministic shard order wins duplicate PRs; no candidate is dispatched twice. The caller
 * commits this plan before any author workflow starts.
 */
function planCandidates(batch: GenerationBatch): void {
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
  if (batch.candidates.length) batch.phase = "authoring";
  else {
    batch.phase = "failed";
    batch.error = "Discovery returned no candidates";
  }
}

async function advanceAuthoring(sweep: Sweep): Promise<void> {
  const { batch, executions, now } = sweep;
  const observed = batch.candidates.filter((item) => due(item, now));
  const snapshots = new Map<Candidate, CandidateSnapshot>();
  await each(sweep, observed, async (item) => {
    if (!mayStart(sweep, item)) return;
    const input = { run: batch.run, candidate: item.candidate };
    snapshots.set(item, await executions.candidate(item.workflowId, input, batch.taskQueue));
  });
  // Results apply in candidate order so a duplicate task ID always loses to the same candidate.
  for (const item of observed) {
    const snapshot = snapshots.get(item);
    if (!snapshot) continue;
    item.observedAt = now;
    applyCandidate(batch, item, snapshot);
  }
  if (batch.candidates.every(settled)) batch.phase = "exporting";
}

/** A result must be this candidate's, and only an accepted one may carry a task. */
function consistent(item: Candidate, result: CandidateWorkflowResult): boolean {
  const id = item.candidate.candidateId;
  if (result.progress.candidateId !== id) return false;
  return !result.task || (result.task.candidateId === id && result.progress.status === "accepted");
}

function applyCandidate(batch: GenerationBatch, item: Candidate, snapshot: CandidateSnapshot) {
  if (snapshot.state === "running") {
    if (snapshot.progress) item.progress = snapshot.progress;
    if (snapshot.cost) item.cost = snapshot.cost;
    return;
  }
  if (snapshot.state === "completed") {
    const result = snapshot.result;
    if (!consistent(item, result)) {
      console.error(
        `Batch ${batch.run.runId} rejected an inconsistent result for ${item.workflowId}`,
      );
      return;
    }
    const taskId = result.task?.taskId;
    if (taskId && batch.candidates.some((other) => other.result?.task?.taskId === taskId))
      item.error = "Another candidate already owns this task ID";
    else item.result = result;
    item.progress = result.progress;
  } else if (snapshot.state === "cancelled") {
    item.cancelled = true;
    item.error = "Generation cancelled.";
  } else item.error = snapshot.error;
  delete item.cost;
}
