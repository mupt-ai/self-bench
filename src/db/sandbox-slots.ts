import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { sandboxSlots } from "./schema.js";

/** A waiter polls at least every 30 s; one that stops leaves the queue. */
const WAITING = sql`now() + interval '2 minutes'`;
/** Bounds a slot leaked by a terminated workflow; longer than any stage's retries. */
const HELD = sql`now() + interval '24 hours'`;
/** A stage that ended abnormally may leave its sandbox running up to the 1 h E2B cap. */
const DRAINING = sql`now() + interval '70 minutes'`;

export type SandboxSlots = ReturnType<typeof createSandboxSlots>;

/**
 * A first-come, first-served queue for managed sandboxes: at most `limit` run at once across the
 * platform, and the oldest waiter gets the next free slot. One advisory lock serializes every
 * decision.
 */
export function createSandboxSlots(db: Database, limit: number) {
  return {
    /** Joins the queue on the first call; true once `id` holds a slot. */
    async acquire(id: string, orgId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('selfbench:sandbox-slots'))`);
        await tx.delete(sandboxSlots).where(lt(sandboxSlots.expiresAt, sql`now()`));
        await tx
          .insert(sandboxSlots)
          .values({ id, orgId, expiresAt: WAITING })
          .onConflictDoNothing();
        const rows = await tx
          .select()
          .from(sandboxSlots)
          .orderBy(asc(sandboxSlots.requestedAt), asc(sandboxSlots.id));
        const own = rows.find((row) => row.id === id);
        if (own?.grantedAt) return true;

        // Free slots go to waiters in arrival order.
        const free = limit - rows.filter((row) => row.grantedAt).length;
        const place = rows.filter((row) => !row.grantedAt).findIndex((row) => row.id === id);
        if (place < free) {
          await tx
            .update(sandboxSlots)
            .set({ grantedAt: sql`now()`, expiresAt: HELD })
            .where(eq(sandboxSlots.id, id));
          return true;
        }
        await tx.update(sandboxSlots).set({ expiresAt: WAITING }).where(eq(sandboxSlots.id, id));
        return false;
      });
    },
    /** Frees a slot, or with `drain` keeps it until the stage's sandbox has certainly stopped. */
    async release(id: string, drain: boolean): Promise<void> {
      if (drain)
        await db
          .update(sandboxSlots)
          .set({ expiresAt: DRAINING })
          .where(and(eq(sandboxSlots.id, id), isNotNull(sandboxSlots.grantedAt)));
      await db
        .delete(sandboxSlots)
        .where(
          drain
            ? and(eq(sandboxSlots.id, id), isNull(sandboxSlots.grantedAt))
            : eq(sandboxSlots.id, id),
        );
    },
  };
}
