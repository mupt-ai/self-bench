import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { repoRuns, users } from "../db/schema.js";

/** A pipeline run whose candidates count as a repository's tasks. */
export interface AttachedRun {
  readonly runId: string;
  readonly attachedBy: string;
  readonly attachedAt: string;
}

export interface RunStore {
  runsFor(repoId: number): Promise<AttachedRun[]>;
  attachRun(repoId: number, runId: string, userId: number): Promise<AttachedRun>;
  /** True when a row was removed. */
  detachRun(repoId: number, runId: string): Promise<boolean>;
}

export function createRunStore(db: Database, options: { now?: () => Date } = {}): RunStore {
  const now = options.now ?? (() => new Date());
  const select = () =>
    db
      .select({ run: repoRuns, login: users.login })
      .from(repoRuns)
      .innerJoin(users, eq(users.id, repoRuns.attachedBy));
  return {
    async runsFor(repoId) {
      const rows = await select()
        .where(eq(repoRuns.repoId, repoId))
        .orderBy(desc(repoRuns.attachedAt), repoRuns.runId);
      return rows.map(runFrom);
    },
    async attachRun(repoId, runId, userId) {
      await db
        .insert(repoRuns)
        .values({ repoId, runId, attachedBy: userId, attachedAt: now() })
        .onConflictDoNothing();
      const [row] = await select().where(
        and(eq(repoRuns.repoId, repoId), eq(repoRuns.runId, runId)),
      );
      if (!row) throw new Error("run attach returned no row");
      return runFrom(row);
    },
    async detachRun(repoId, runId) {
      const rows = await db
        .delete(repoRuns)
        .where(and(eq(repoRuns.repoId, repoId), eq(repoRuns.runId, runId)))
        .returning({ runId: repoRuns.runId });
      return rows.length > 0;
    },
  };
}

function runFrom(row: { run: typeof repoRuns.$inferSelect; login: string }): AttachedRun {
  return {
    runId: row.run.runId,
    attachedBy: row.login,
    attachedAt: row.run.attachedAt.toISOString(),
  };
}
