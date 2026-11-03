/**
 * Where an evaluation's records live: a connected repository's evaluations (`repoId`), a
 * benchmark's (`benchmarkId`): a Harbor registry dataset an org added, run with no repository, or
 * a repository group's (`groupId`): several connected repositories' approved tasks run together.
 * Exactly one is set. Evaluations from before benchmarks carry only `repoId`.
 */
export interface EvaluationScope {
  repoId?: number;
  benchmarkId?: number;
  groupId?: number;
}

/** The scope's own fields, so two scopes compare by value and a record names exactly one. */
export function scopeOf(value: EvaluationScope): EvaluationScope {
  const { repoId, benchmarkId, groupId } = value;
  const valid = (id: number | undefined): id is number =>
    id !== undefined && Number.isSafeInteger(id) && id >= 1;
  const set = [repoId, benchmarkId, groupId].filter((id) => id !== undefined).length;
  if (set === 1) {
    if (valid(repoId)) return { repoId };
    if (valid(benchmarkId)) return { benchmarkId };
    if (valid(groupId)) return { groupId };
  }
  throw new Error("Invalid evaluation identity");
}

export function sameScope(left: EvaluationScope, right: EvaluationScope): boolean {
  return (
    left.repoId === right.repoId &&
    left.benchmarkId === right.benchmarkId &&
    left.groupId === right.groupId
  );
}

/** Where a scope's records sit under a store's root: `repos/1`, `benchmarks/2`, `groups/3`. */
export function scopePath(scope: EvaluationScope): string {
  const { repoId, benchmarkId, groupId } = scopeOf(scope);
  if (repoId !== undefined) return `repos/${repoId}`;
  return benchmarkId !== undefined ? `benchmarks/${benchmarkId}` : `groups/${groupId}`;
}

/** A short key naming the scope, for workflow ids and in-memory maps. */
export function scopeKey(scope: EvaluationScope): string {
  const { repoId, benchmarkId, groupId } = scopeOf(scope);
  // Repository keys stay bare numbers: running evaluations are found by the ids they started with.
  if (repoId !== undefined) return `${repoId}`;
  return benchmarkId !== undefined ? `benchmark-${benchmarkId}` : `group-${groupId}`;
}
