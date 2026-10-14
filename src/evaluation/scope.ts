/**
 * Where an evaluation's records live: a connected repository's evaluations (`repoId`), or a
 * benchmark's (`benchmarkId`): a Harbor registry dataset an org added, run with no repository.
 * Exactly one is set. Evaluations from before benchmarks carry only `repoId`.
 */
export interface EvaluationScope {
  repoId?: number;
  benchmarkId?: number;
}

/** The scope's own fields, so two scopes compare by value and a record names exactly one. */
export function scopeOf(value: EvaluationScope): EvaluationScope {
  const { repoId, benchmarkId } = value;
  const valid = (id: number) => Number.isSafeInteger(id) && id >= 1;
  if (repoId !== undefined && benchmarkId === undefined && valid(repoId)) return { repoId };
  if (benchmarkId !== undefined && repoId === undefined && valid(benchmarkId))
    return { benchmarkId };
  throw new Error("Invalid evaluation identity");
}

export function sameScope(left: EvaluationScope, right: EvaluationScope): boolean {
  return left.repoId === right.repoId && left.benchmarkId === right.benchmarkId;
}

/** A short key naming the scope, for workflow ids and in-memory maps. */
export function scopeKey(scope: EvaluationScope): string {
  const { repoId, benchmarkId } = scopeOf(scope);
  // Repository keys stay bare numbers: running evaluations are found by the ids they started with.
  return repoId !== undefined ? `${repoId}` : `benchmark-${benchmarkId}`;
}
