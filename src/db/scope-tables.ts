import { type EvaluationScope, scopeOf } from "../evaluation/scope.js";
import {
  benchmarkSummaries,
  benchmarks,
  evaluationSummaries,
  groupSummaries,
  repos,
  repositoryGroups,
  runBatches,
} from "./schema.js";

/**
 * Where each kind of evaluation scope lives in the database: the table that owns it (and its
 * org), the table its run summaries are kept in, and the column of `batches` naming it. The
 * three kinds' tables have the same shape, so stores branch here, once, rather than each its own.
 */
export function scopeTables(scope: EvaluationScope) {
  const { repoId, benchmarkId, groupId } = scopeOf(scope);
  if (repoId !== undefined)
    return {
      id: repoId,
      owner: repos,
      summaries: evaluationSummaries,
      summaryOwner: evaluationSummaries.repoId,
      summaryKey: "repoId" as const,
      batch: runBatches.repoId,
    };
  if (benchmarkId !== undefined)
    return {
      id: benchmarkId,
      owner: benchmarks,
      summaries: benchmarkSummaries,
      summaryOwner: benchmarkSummaries.benchmarkId,
      summaryKey: "benchmarkId" as const,
      batch: runBatches.benchmarkId,
    };
  return {
    id: groupId ?? 0,
    owner: repositoryGroups,
    summaries: groupSummaries,
    summaryOwner: groupSummaries.groupId,
    summaryKey: "groupId" as const,
    batch: runBatches.groupId,
  };
}
