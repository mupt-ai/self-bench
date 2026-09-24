import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { sandboxSlots } from "./schema.js";

export interface SlotLimits {
  /** Managed sandboxes running at once across the platform. */
  readonly total: number;
  /** Managed sandboxes one organization may hold at once. */
  readonly perOrg: number;
}

/** A waiter polls at least every 30 s; one that stops leaves the queue. */
const WAITING = sql`now() + interval '2 minutes'`;
/** Bounds a slot leaked by a terminated workflow; longer than any stage's retries. */
const HELD = sql`now() + interval '24 hours'`;
/** A stage that ended abnormally may leave its sandbox running up to the 1 h E2B cap. */
const DRAINING = sql`now() + interval '70 minutes'`;

export type SandboxSlots = ReturnType<typeof createSandboxSlots>;

/**
 * A first-come, first-served queue for managed sandboxes: the oldest waiter whose organization
 * is under its limit gets the next free slot. One advisory lock serializes every decision.
 */
export function createSandboxSlots(db: Database, limits: SlotLimits) {
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

        const held = new Map<string, number>();
        let total = 0;
        const take = (org: string) => {
          held.set(org, (held.get(org) ?? 0) + 1);
          total += 1;
        };
        for (const row of rows) if (row.grantedAt) take(row.orgId);
        // Hand out free slots in arrival order, skipping organizations at their limit.
        for (const row of rows) {
          if (row.grantedAt) continue;
          if (total >= limits.total) break;
          if ((held.get(row.orgId) ?? 0) >= limits.perOrg) continue;
          if (row.id === id) {
            await tx
              .update(sandboxSlots)
              .set({ grantedAt: sql`now()`, expiresAt: HELD })
              .where(eq(sandboxSlots.id, id));
            return true;
          }
          take(row.orgId); // An older waiter gets this slot when it next polls.
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
