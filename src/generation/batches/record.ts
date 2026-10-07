import type {
  ArtifactRef,
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  DiscoveryResult,
} from "../../contracts/index.js";
import { type GenerationBatch, isFinished, settled } from "./types.js";

/**
 * How the batch workflow changes a batch record. Each change applies under the record's row
 * lock and returns whether it changed anything, so a retried activity is harmless.
 */

/** What a child workflow ended with: its result, or why it has none. */
export type Outcome<T> = { result: T } | { error: string };
type Candidate = GenerationBatch["candidates"][number];

export const CANCELLED = "Generation cancelled.";

/** A cancelled batch keeps what finished; everything else ends as cancelled. */
export function finishCancel(batch: GenerationBatch): boolean {
  if (isFinished(batch.phase)) return false;
  batch.phase = "cancelled";
  for (const item of [...batch.shards, ...batch.candidates])
    if (!settled(item)) item.error = CANCELLED;
  return true;
}

/**
 * A failed batch's workflow closes, which terminates any child still running. A cancel the
 * workflow had not yet seen still wins.
 */
export function fail(batch: GenerationBatch, error: string): boolean {
  if (batch.phase === "cancelling") return finishCancel(batch);
  if (isFinished(batch.phase)) return false;
  batch.phase = "failed";
  batch.error = error;
  for (const item of [...batch.shards, ...batch.candidates]) if (!settled(item)) item.error = error;
  return true;
}

export function recordShards(batch: GenerationBatch, shards: GenerationBatch["shards"]): boolean {
  if (batch.phase === "cancelling") return finishCancel(batch);
  if (batch.phase !== "preparing") return false;
  batch.phase = "discovering";
  batch.shards = shards;
  return true;
}

/** A shard that finishes while a cancel is pending still records what it found. */
export function recordShard(
  batch: GenerationBatch,
  index: number,
  outcome: Outcome<DiscoveryResult>,
): boolean {
  const shard = batch.shards[index];
  if (!["discovering", "cancelling"].includes(batch.phase) || !shard || settled(shard))
    return false;
  if ("error" in outcome) shard.error = outcome.error;
  else shard.result = outcome.result;
  return true;
}

/**
 * Deterministic shard order wins duplicate PRs and a tier's last slots; no candidate is
 * dispatched twice, and no tier gets more than requested. The plan commits before any author
 * workflow starts.
 */
export function planCandidates(batch: GenerationBatch): boolean {
  if (batch.phase === "cancelling") return finishCancel(batch);
  if (batch.phase !== "discovering") return false;
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (const shard of batch.shards)
    for (const candidate of shard.result?.candidates ?? []) {
      if (seen.has(candidate.sourcePr)) continue;
      const tier = candidates.filter(
        (item) => item.candidate.difficulty === candidate.difficulty,
      ).length;
      if (tier >= batch.run.candidateCounts[candidate.difficulty]) continue;
      seen.add(candidate.sourcePr);
      if (candidates.some((item) => item.candidate.candidateId === candidate.candidateId))
        return fail(batch, "Duplicate candidate ID across discovery shards");
      candidates.push({
        workflowId: `${batch.run.runId}/candidate/${candidate.candidateId}`,
        candidate,
      });
    }
  if (!candidates.length) return fail(batch, "Discovery returned no candidates");
  batch.phase = "authoring";
  batch.candidates = candidates;
  return true;
}

/** The author workflows a planned batch starts, one per candidate. */
export function plannedCandidates(
  batch: GenerationBatch,
): { workflowId: string; input: CandidateWorkflowInput }[] {
  if (batch.phase !== "authoring") return [];
  return batch.candidates.map((item) => ({
    workflowId: item.workflowId,
    input: { run: batch.run, candidate: item.candidate },
  }));
}

/** A result must be this candidate's, and only an accepted one may carry a task. */
function consistent(item: Candidate, result: CandidateWorkflowResult): boolean {
  const id = item.candidate.candidateId;
  if (result.progress.candidateId !== id) return false;
  return !result.task || (result.task.candidateId === id && result.progress.status === "accepted");
}

/** A task ID belongs to the candidate that finished with it first. */
export function recordCandidate(
  batch: GenerationBatch,
  index: number,
  outcome: Outcome<CandidateWorkflowResult>,
): boolean {
  const item = batch.candidates[index];
  if (!["authoring", "cancelling"].includes(batch.phase) || !item || settled(item)) return false;
  if ("error" in outcome) item.error = outcome.error;
  // A completed workflow never reruns, so a bad result settles the candidate as failed.
  else if (!consistent(item, outcome.result))
    item.error = "Candidate returned an inconsistent result";
  else {
    const taskId = outcome.result.task?.taskId;
    if (taskId && batch.candidates.some((other) => other.result?.task?.taskId === taskId))
      item.error = "Another candidate already owns this task ID";
    else item.result = outcome.result;
  }
  return true;
}

export function beginExport(batch: GenerationBatch): boolean {
  if (batch.phase === "cancelling") return finishCancel(batch);
  if (batch.phase !== "authoring" || !batch.candidates.every(settled)) return false;
  batch.phase = "exporting";
  return true;
}

/** A batch cancelled while it exported stays cancelled. */
export function completeExport(batch: GenerationBatch, reference: ArtifactRef): boolean {
  if (batch.phase === "cancelling") return finishCancel(batch);
  if (batch.phase !== "exporting") return false;
  batch.phase = "complete";
  batch.export = reference;
  return true;
}

/**
 * Settles a batch whose workflow closed, or never started, without recording an outcome: a
 * terminated or timed-out workflow skips its own failure handling.
 */
export function abandon(batch: GenerationBatch, workflowStatus: string | undefined): boolean {
  return fail(
    batch,
    workflowStatus
      ? `Batch workflow ${workflowStatus.toLowerCase().replaceAll("_", " ")} without recording an outcome.`
      : "Batch workflow never started. Start another batch.",
  );
}
