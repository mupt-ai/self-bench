import { eq, lte } from "drizzle-orm";
import type { Database } from "./client.js";
import { evaluationSummaries } from "./schema.js";

/** A run's summary as stored: the snapshot revision it was made from, and its JSON. */
export interface StoredRunSummary {
  id: string;
  revision: number;
  body: string;
}

/** Whether a write failed because its repository's row is gone (a foreign key violation). */
function noSuchRepository(error: unknown): boolean {
  const { cause = error } = error as { cause?: unknown };
  return (cause as { code?: unknown } | undefined)?.code === "23503";
}

/**
 * Evaluation run summaries (schema.ts): one per run, replaced only by the same or a later
 * revision's, so writers that finish out of order never put an older one back. The same
 * revision's summary is the same summary, so a rebuild may write over a stored one.
 */
export function createRunSummaryStore(db: Database) {
  return {
    async save(repoId: number, summary: StoredRunSummary): Promise<void> {
      const { revision, body } = summary;
      await db
        .insert(evaluationSummaries)
        .values({ repoId, ...summary })
        .onConflictDoUpdate({
          target: [evaluationSummaries.repoId, evaluationSummaries.id],
          set: { revision, body },
          setWhere: lte(evaluationSummaries.revision, revision),
        })
        .catch((error: unknown) => {
          // A repository disconnected mid-run has no summaries to keep: nothing lists its runs.
          if (!noSuchRepository(error)) throw error;
        });
    },
    /** The revision each of a repository's summaries was made from, by run id. */
    async revisions(repoId: number): Promise<Map<string, number>> {
      const rows = await db
        .select({ id: evaluationSummaries.id, revision: evaluationSummaries.revision })
        .from(evaluationSummaries)
        .where(eq(evaluationSummaries.repoId, repoId));
      return new Map(rows.map((row) => [row.id, row.revision]));
    },
    async list(repoId: number): Promise<StoredRunSummary[]> {
      return db
        .select({
          id: evaluationSummaries.id,
          revision: evaluationSummaries.revision,
          body: evaluationSummaries.body,
        })
        .from(evaluationSummaries)
        .where(eq(evaluationSummaries.repoId, repoId));
    },
  };
}
export type RunSummaryStore = ReturnType<typeof createRunSummaryStore>;
