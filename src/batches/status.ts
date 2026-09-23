import type { RunStatus } from "../contracts/index.js";
import { generationCost } from "../managed/cost-status.js";
import type { RunUsageSummary } from "../managed/usage.js";
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

export function batchStatus(batch: GenerationBatch): RunStatus {
  const provider = batch.run.version.executionBackend;
  const model = batch.run.generation?.settings.authorModel ?? batch.run.authoring.model;
  const tasks = batch.candidates.map((item) =>
    item.result
      ? item.result.progress
      : item.cancelled
        ? {
            candidateId: item.candidate.candidateId,
            taskId: item.candidate.candidateId,
            difficulty: item.candidate.difficulty,
            status: "infrastructure_failed" as const,
            reason: item.error ?? "Generation cancelled.",
          }
        : item.error
          ? {
              candidateId: item.candidate.candidateId,
              taskId: item.candidate.candidateId,
              difficulty: item.candidate.difficulty,
              status: "infrastructure_failed" as const,
              reason: item.error,
            }
          : (item.progress ?? {
              candidateId: item.candidate.candidateId,
              taskId: item.candidate.candidateId,
              difficulty: item.candidate.difficulty,
              status: "queued" as const,
            }),
  );
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
