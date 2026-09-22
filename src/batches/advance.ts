import { MAX_CONCURRENT_CANDIDATE_WORKFLOWS } from "../execution-limits.js";
import type { BatchExecutions } from "./temporal.js";
import type { GenerationBatch } from "./types.js";

/** One durable application sweep; SDK outages throw so the persisted plan remains retryable. */
export async function advanceBatch(
  batch: GenerationBatch,
  executions: BatchExecutions,
): Promise<void> {
  if (batch.phase === "cancelling") {
    const pending = [...batch.shards, ...batch.candidates].filter((item) => !item.cancelled);
    const item = pending[(batch.cursor ?? 0) % Math.max(1, pending.length)];
    batch.cursor = (batch.cursor ?? 0) + 1;
    if (
      item &&
      (!item.dispatchAttempted || (await executions.cancel(item.workflowId, batch.taskQueue)))
    )
      item.cancelled = true;
    if ([...batch.shards, ...batch.candidates].every((item) => item.cancelled))
      batch.phase = "cancelled";
    return;
  }
  if (batch.phase === "discovering") {
    const pending = batch.shards.filter((shard) => !shard.result && !shard.error);
    const shard = pending[(batch.cursor ?? 0) % Math.max(1, pending.length)];
    batch.cursor = (batch.cursor ?? 0) + 1;
    if (shard && !shard.dispatchAttempted) {
      shard.dispatchAttempted = true;
      return;
    }
    if (shard) {
      const observed = await executions.shard(shard.workflowId, shard.input, batch.taskQueue);
      if (observed.state === "completed") shard.result = observed.result;
      else if (observed.state === "failed") shard.error = observed.error;
    }
    if (batch.shards.some((shard) => !shard.result && !shard.error)) return;
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
    batch.cursor = 0;
    return; // Commit the candidate dispatch plan before starting any author workflow.
  }
  if (batch.phase !== "authoring") return;
  const pending = batch.candidates.filter((item) => !item.result && !item.error);
  const active = pending.filter((item) => item.dispatchAttempted);
  const eligible = active.length >= MAX_CONCURRENT_CANDIDATE_WORKFLOWS ? active : pending;
  const item = eligible[(batch.cursor ?? 0) % Math.max(1, eligible.length)];
  batch.cursor = (batch.cursor ?? 0) + 1;
  if (item && !item.dispatchAttempted) {
    item.dispatchAttempted = true;
    return;
  }
  if (item) {
    const observed = await executions.candidate(
      item.workflowId,
      { run: batch.run, candidate: item.candidate },
      batch.taskQueue,
    );
    if (observed.state === "completed") {
      if (observed.result.progress.candidateId !== item.candidate.candidateId)
        throw new Error("Candidate result identity mismatch");
      const result = observed.result;
      if (
        result.task &&
        (result.task.candidateId !== item.candidate.candidateId ||
          result.progress.status !== "accepted")
      )
        throw new Error("Nonaccepted candidate returned an export task");
      if (
        result.task &&
        batch.candidates.some(
          (other) => other !== item && other.result?.task?.taskId === result.task?.taskId,
        )
      ) {
        item.error = "Another candidate already owns this task ID";
      } else item.result = result;
      item.progress = observed.result.progress;
    } else if (observed.state === "failed") item.error = observed.error;
    else if (observed.progress) item.progress = observed.progress;
  }
  if (batch.candidates.every((item) => item.result || item.error)) batch.phase = "exporting";
}
