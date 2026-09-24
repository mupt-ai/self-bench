import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { workflowSlots } from "./schema.js";

/** A waiter polls at least every 30 s; one that stops leaves the queue. */
const WAITING = sql`now() + interval '2 minutes'`;
/** Outlives the 14-day workflow execution timeout; only bounds a slot leaked by termination. */
const HELD = sql`now() + interval '15 days'`;
/** A workflow that ended abnormally may leave its sandbox running up to the 1 h E2B cap. */
const DRAINING = sql`now() + interval '70 minutes'`;

export type WorkflowSlots = ReturnType<typeof createWorkflowSlots>;

/**
 * A first-come, first-served queue for managed generation workflows: at most `limit` run at once
 * across the platform, and the oldest waiter gets the next free slot. One advisory lock
 * serializes every decision.
 */
export function createWorkflowSlots(db: Database, limit: number) {
  return {
    /** Joins the queue on the first call; true once `id` holds a slot. */
    async acquire(id: string, orgId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('selfbench:workflow-slots'))`);
        await tx.delete(workflowSlots).where(lt(workflowSlots.expiresAt, sql`now()`));
        await tx
          .insert(workflowSlots)
          .values({ id, orgId, expiresAt: WAITING })
          .onConflictDoNothing();
        const rows = await tx
          .select()
          .from(workflowSlots)
          .orderBy(asc(workflowSlots.requestedAt), asc(workflowSlots.id));
        const own = rows.find((row) => row.id === id);
        if (own?.grantedAt) return true;

        // Free slots go to waiters in arrival order.
        const free = limit - rows.filter((row) => row.grantedAt).length;
        const place = rows.filter((row) => !row.grantedAt).findIndex((row) => row.id === id);
        if (place < free) {
          await tx
            .update(workflowSlots)
            .set({ grantedAt: sql`now()`, expiresAt: HELD })
            .where(eq(workflowSlots.id, id));
          return true;
        }
        await tx.update(workflowSlots).set({ expiresAt: WAITING }).where(eq(workflowSlots.id, id));
        return false;
      });
    },
    /** Frees a slot, or with `drain` keeps it until the workflow's sandbox has certainly stopped. */
    async release(id: string, drain: boolean): Promise<void> {
      if (drain)
        await db
          .update(workflowSlots)
          .set({ expiresAt: DRAINING })
          .where(and(eq(workflowSlots.id, id), isNotNull(workflowSlots.grantedAt)));
      await db
        .delete(workflowSlots)
        .where(
          drain
            ? and(eq(workflowSlots.id, id), isNull(workflowSlots.grantedAt))
            : eq(workflowSlots.id, id),
        );
    },
  };
}
