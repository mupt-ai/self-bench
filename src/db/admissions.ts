import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { sandboxAdmissions } from "./schema.js";

export interface AdmissionRequest {
  /** Stable across retries of the same wait, so a retried poll never takes a second slot. */
  readonly id: string;
  /** The provider account the sandbox runs on; its limit is shared by every worker. */
  readonly pool: string;
  readonly orgId: string;
  readonly kind: "agent" | "harbor";
}

/** A held slot outlives any sandbox; release is explicit and this only bounds a leak. */
const GRANT_TTL = sql`now() + interval '8 hours'`;
/** Waiters poll at least every 30 s; one that stops polling leaves the queue. */
const WAIT_TTL = sql`now() + interval '2 minutes'`;

export type AdmissionStore = ReturnType<typeof createAdmissionStore>;

/**
 * Admission to a shared provider account. Each pool's rows are serialized by a transaction
 * advisory lock, so every worker replica sees one consistent count.
 */
export function createAdmissionStore(db: Database) {
  const table = sandboxAdmissions;
  return {
    /** True once `request` holds one of the pool's `limit` slots; waiters are served oldest first. */
    async acquire(request: AdmissionRequest, limit: number): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${request.pool}))`);
        await tx
          .delete(table)
          .where(and(eq(table.pool, request.pool), lt(table.expiresAt, sql`now()`)));
        const rows = await tx
          .select({ id: table.id, grantedAt: table.grantedAt })
          .from(table)
          .where(eq(table.pool, request.pool))
          .orderBy(table.requestedAt, table.id);
        const own = rows.find((row) => row.id === request.id);
        if (own?.grantedAt) return true;
        if (own)
          await tx.update(table).set({ expiresAt: WAIT_TTL }).where(eq(table.id, request.id));
        else {
          await tx.insert(table).values({ ...request, expiresAt: WAIT_TTL });
          rows.push({ id: request.id, grantedAt: null });
        }
        const free = limit - rows.filter((row) => row.grantedAt).length;
        const place = rows
          .filter((row) => !row.grantedAt)
          .findIndex((row) => row.id === request.id);
        if (place >= free) return false;
        await tx
          .update(table)
          .set({ grantedAt: sql`now()`, expiresAt: GRANT_TTL })
          .where(and(eq(table.id, request.id), isNull(table.grantedAt)));
        return true;
      });
    },
    /** Frees a held slot or leaves the queue; releasing twice is harmless. */
    async release(id: string): Promise<void> {
      await db.delete(table).where(eq(table.id, id));
    },
  };
}
