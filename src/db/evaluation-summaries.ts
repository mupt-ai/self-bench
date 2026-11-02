import { eq, lt } from "drizzle-orm";
import { type EvaluationScope, scopeOf } from "../evaluation/scope.js";
import type { Database } from "./client.js";
import { benchmarkSummaries, evaluationSummaries, groupSummaries } from "./schema.js";

/** A run's summary as stored: the snapshot revision it was made from, and its JSON. */
export interface StoredRunSummary {
  id: string;
  revision: number;
  body: string;
}

/** Whether a write failed because its repository's or benchmark's row is gone (a foreign key violation). */
function noSuchOwner(error: unknown): boolean {
  const { cause = error } = error as { cause?: unknown };
  return (cause as { code?: unknown } | undefined)?.code === "23503";
}

/**
 * Evaluation run summaries (schema.ts): one per run, replaced only by a later revision's, so
 * writers that finish out of order never put an older one back. A repository's runs keep theirs
 * in evaluation_summaries, a benchmark's in benchmark_summaries, a group's in group_summaries.
 */
export function createRunSummaryStore(db: Database) {
  /** The table a scope's summaries are kept in, and the column naming the scope's owner. */
  const tableOf = (scope: EvaluationScope) => {
    const { repoId, benchmarkId, groupId } = scopeOf(scope);
    if (repoId !== undefined)
      return { table: evaluationSummaries, owner: evaluationSummaries.repoId, ownerId: repoId };
    if (benchmarkId !== undefined)
      return {
        table: benchmarkSummaries,
        owner: benchmarkSummaries.benchmarkId,
        ownerId: benchmarkId,
      };
    return { table: groupSummaries, owner: groupSummaries.groupId, ownerId: groupId ?? 0 };
  };
  return {
    async save(scope: EvaluationScope, summary: StoredRunSummary): Promise<void> {
      const { repoId, benchmarkId, groupId } = scopeOf(scope);
      const { revision, body } = summary;
      const write =
        repoId !== undefined
          ? db
              .insert(evaluationSummaries)
              .values({ repoId, ...summary })
              .onConflictDoUpdate({
                target: [evaluationSummaries.repoId, evaluationSummaries.id],
                set: { revision, body },
                setWhere: lt(evaluationSummaries.revision, revision),
              })
          : benchmarkId !== undefined
            ? db
                .insert(benchmarkSummaries)
                .values({ benchmarkId, ...summary })
                .onConflictDoUpdate({
                  target: [benchmarkSummaries.benchmarkId, benchmarkSummaries.id],
                  set: { revision, body },
                  setWhere: lt(benchmarkSummaries.revision, revision),
                })
            : db
                .insert(groupSummaries)
                .values({ groupId: groupId ?? 0, ...summary })
                .onConflictDoUpdate({
                  target: [groupSummaries.groupId, groupSummaries.id],
                  set: { revision, body },
                  setWhere: lt(groupSummaries.revision, revision),
                });
      await write.catch((error: unknown) => {
        // A repository disconnected (or benchmark or group removed) mid-run has no summaries to
        // keep: nothing lists its runs.
        if (!noSuchOwner(error)) throw error;
      });
    },
    /** The revision each of a scope's summaries was made from, by run id. */
    async revisions(scope: EvaluationScope): Promise<Map<string, number>> {
      const { table, owner, ownerId } = tableOf(scope);
      const rows = await db
        .select({ id: table.id, revision: table.revision })
        .from(table)
        .where(eq(owner, ownerId));
      return new Map(rows.map((row) => [row.id, row.revision]));
    },
    async list(scope: EvaluationScope): Promise<StoredRunSummary[]> {
      const { table, owner, ownerId } = tableOf(scope);
      return db
        .select({ id: table.id, revision: table.revision, body: table.body })
        .from(table)
        .where(eq(owner, ownerId));
    },
  };
}
export type RunSummaryStore = ReturnType<typeof createRunSummaryStore>;
