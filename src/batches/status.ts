import type { RunStatus } from "../contracts.js";
import type { GenerationBatch } from "./types.js";

export function batchStatus(batch: GenerationBatch): RunStatus {
  const tasks = batch.candidates.map((item) =>
    item.error
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
    discovery: {
      wave: 0,
      totalShards: batch.shards.length,
      completedShards: batch.shards.filter((shard) => shard.result).length,
      failedShards: batch.shards.filter((shard) => shard.error).length,
      candidates: batch.shards.reduce(
        (count, shard) => count + (shard.result?.candidates.length ?? 0),
        0,
      ),
    },
    ...(batch.export ? { export: batch.export } : {}),
    ...(batch.error ? { error: batch.error } : {}),
  };
}
