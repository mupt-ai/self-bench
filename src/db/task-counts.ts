import { and, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { tasks } from "./schema.js";

/** Counts visible tasks per repository for the repository list. */
export async function taskCountsForRepos(db: Database, repoIds: readonly number[]) {
  if (repoIds.length === 0) return [];
  const count = (condition: ReturnType<typeof sql>) =>
    sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
  const rows = await db
    .select({
      repoId: tasks.repoId,
      total: sql<number>`count(*)`.mapWith(Number),
      accepted: count(sql`${tasks.reviewDecision} = 'approve'`),
      needsReview: count(
        sql`${tasks.reviewDecision} is null and ${tasks.pipelineStatus} = 'accepted'`,
      ),
      rejected: count(
        sql`${tasks.reviewDecision} = 'reject' or (${tasks.reviewDecision} is null and ${tasks.pipelineStatus} in ('rejected', 'infrastructure_failed'))`,
      ),
      lastPr: sql<number | null>`max(${tasks.sourcePr})`,
    })
    .from(tasks)
    .where(and(inArray(tasks.repoId, [...repoIds]), isNull(tasks.deletedAt)))
    .groupBy(tasks.repoId);
  return rows.map((row) => ({
    repoId: row.repoId,
    total: row.total,
    accepted: row.accepted,
    needsReview: row.needsReview,
    rejected: row.rejected,
    ...(row.lastPr !== null ? { lastPr: Number(row.lastPr) } : {}),
  }));
}
