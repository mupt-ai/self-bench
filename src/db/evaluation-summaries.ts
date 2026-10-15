import { eq, lt } from "drizzle-orm";
import { type EvaluationScope, scopeOf } from "../evaluation/scope.js";
import type { Database } from "./client.js";
import { benchmarkSummaries, evaluationSummaries } from "./schema.js";

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
 * in evaluation_summaries, a benchmark's in benchmark_summaries.
 */
export function createRunSummaryStore(db: Database) {
  const columns = {
    id: evaluationSummaries.id,
    revision: evaluationSummaries.revision,
    body: evaluationSummaries.body,
  };
  const benchmarkColumns = {
    id: benchmarkSummaries.id,
    revision: benchmarkSummaries.revision,
    body: benchmarkSummaries.body,
  };
  return {
    async save(scope: EvaluationScope, summary: StoredRunSummary): Promise<void> {
      const { repoId, benchmarkId } = scopeOf(scope);
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
          : db
              .insert(benchmarkSummaries)
              .values({ benchmarkId: benchmarkId ?? 0, ...summary })
              .onConflictDoUpdate({
                target: [benchmarkSummaries.benchmarkId, benchmarkSummaries.id],
                set: { revision, body },
                setWhere: lt(benchmarkSummaries.revision, revision),
              });
      await write.catch((error: unknown) => {
        // A repository disconnected (or benchmark removed) mid-run has no summaries to keep: nothing
        // lists its runs.
        if (!noSuchOwner(error)) throw error;
      });
    },
    /** The revision each of a scope's summaries was made from, by run id. */
    async revisions(scope: EvaluationScope): Promise<Map<string, number>> {
      const { repoId, benchmarkId } = scopeOf(scope);
      const rows =
        repoId !== undefined
          ? await db
              .select({ id: evaluationSummaries.id, revision: evaluationSummaries.revision })
              .from(evaluationSummaries)
              .where(eq(evaluationSummaries.repoId, repoId))
          : await db
              .select({ id: benchmarkSummaries.id, revision: benchmarkSummaries.revision })
              .from(benchmarkSummaries)
              .where(eq(benchmarkSummaries.benchmarkId, benchmarkId ?? 0));
      return new Map(rows.map((row) => [row.id, row.revision]));
    },
    async list(scope: EvaluationScope): Promise<StoredRunSummary[]> {
      const { repoId, benchmarkId } = scopeOf(scope);
      return repoId !== undefined
        ? db.select(columns).from(evaluationSummaries).where(eq(evaluationSummaries.repoId, repoId))
        : db
            .select(benchmarkColumns)
            .from(benchmarkSummaries)
            .where(eq(benchmarkSummaries.benchmarkId, benchmarkId ?? 0));
    },
  };
}
export type RunSummaryStore = ReturnType<typeof createRunSummaryStore>;
