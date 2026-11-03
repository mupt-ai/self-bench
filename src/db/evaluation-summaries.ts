import { eq, lt } from "drizzle-orm";
import type { EvaluationScope } from "../evaluation/scope.js";
import type { Database } from "./client.js";
import type { evaluationSummaries } from "./schema.js";
import { scopeTables } from "./scope-tables.js";

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
  return {
    async save(scope: EvaluationScope, summary: StoredRunSummary): Promise<void> {
      const { id, summaries, summaryOwner, summaryKey } = scopeTables(scope);
      const { revision, body } = summary;
      // The three summary tables differ only in the name of the column naming their owner.
      const table = summaries as typeof evaluationSummaries;
      await db
        .insert(table)
        .values({ [summaryKey]: id, ...summary } as typeof evaluationSummaries.$inferInsert)
        .onConflictDoUpdate({
          target: [summaryOwner, table.id],
          set: { revision, body },
          setWhere: lt(table.revision, revision),
        })
        .catch((error: unknown) => {
          // A repository disconnected (or benchmark or group removed) mid-run has no summaries
          // to keep: nothing lists its runs.
          if (!noSuchOwner(error)) throw error;
        });
    },
    /** The revision each of a scope's summaries was made from, by run id. */
    async revisions(scope: EvaluationScope): Promise<Map<string, number>> {
      const { id, summaries: table, summaryOwner } = scopeTables(scope);
      const rows = await db
        .select({ id: table.id, revision: table.revision })
        .from(table)
        .where(eq(summaryOwner, id));
      return new Map(rows.map((row) => [row.id, row.revision]));
    },
    async list(scope: EvaluationScope): Promise<StoredRunSummary[]> {
      const { id, summaries: table, summaryOwner } = scopeTables(scope);
      return db
        .select({ id: table.id, revision: table.revision, body: table.body })
        .from(table)
        .where(eq(summaryOwner, id));
    },
  };
}
export type RunSummaryStore = ReturnType<typeof createRunSummaryStore>;
