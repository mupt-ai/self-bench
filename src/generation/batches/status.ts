import type { RunStatus, TaskProgress } from "../../contracts/index.js";
import type { TaskRecord } from "../../db/tasks.js";
import { generationCost } from "../billing/cost-status.js";
import type { RunUsageSummary } from "../billing/usage.js";
import { rowProgress } from "../tasks/activities.js";
import type { GenerationBatch } from "./types.js";

const EMPTY_USAGE: RunUsageSummary = {
  settledStages: [],
  modelCostUsd: undefined,
  sandboxCostUsd: undefined,
  managedCostUsd: 0,
  modelTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  tokens: 0,
  sandboxSeconds: 0,
};

/**
 * A batch as its page shows it. Each candidate stands as its task row says; a batch outside any
 * repository has no rows, and shows its candidates as the batch record settled them.
 */
export function batchStatus(batch: GenerationBatch, rows: readonly TaskRecord[] = []): RunStatus {
  const provider = batch.run.version.executionBackend;
  const model = batch.run.generation?.settings.authorModel ?? batch.run.authoring.model;
  const byCandidate = new Map(rows.map((row) => [row.candidateId, row]));
  const tasks = batch.candidates.map((item) => {
    const row = byCandidate.get(item.candidate.candidateId);
    return row ? rowProgress(row) : recordedProgress(item);
  });
  return {
    runId: batch.run.runId,
    phase: batch.phase,
    requested: Object.values(batch.run.candidateCounts).reduce((a, b) => a + b, 0),
    requestedByDifficulty: batch.run.candidateCounts,
    discovered:
      batch.candidates.length ||
      batch.shards.reduce((count, shard) => count + (shard.result?.candidates.length ?? 0), 0),
    accepted: tasks.filter((task) => task.status === "accepted").length,
    rejected: tasks.filter((task) => task.status === "rejected").length,
    tasks,
    cost: generationCost(
      EMPTY_USAGE,
      provider,
      model,
      [...batch.shards, ...batch.candidates]
        .map((item) => (!item.result ? item.cost : undefined))
        .filter((cost) => cost !== undefined),
    ),
    discovery: {
      wave: 0,
      totalShards: batch.shards.length,
      completedShards: batch.shards.filter((shard) => shard.result).length,
      failedShards: batch.shards.filter((shard) => shard.error).length,
      candidates: batch.shards.reduce(
        (count, shard) => count + (shard.result?.candidates.length ?? 0),
        0,
      ),
      shards: batch.shards.map((shard) => ({
        wave: shard.input.wave,
        shardIndex: shard.input.shardIndex,
        cost: generationCost(EMPTY_USAGE, provider, model, shard.cost),
        ...(shard.error ? { error: shard.error } : {}),
      })),
    },
    ...(batch.export ? { export: batch.export } : {}),
    ...(batch.error ? { error: batch.error } : {}),
  };
}

function recordedProgress(item: GenerationBatch["candidates"][number]): TaskProgress {
  if (item.result) return item.result.progress;
  const { candidateId, difficulty } = item.candidate;
  const base = { candidateId, taskId: candidateId, difficulty };
  if (item.cancelled || item.error !== undefined)
    return {
      ...base,
      status: "infrastructure_failed",
      reason: item.error ?? "Generation cancelled.",
    };
  return { ...base, status: "queued" };
}
