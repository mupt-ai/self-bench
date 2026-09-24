import { and, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { sandboxAdmissions } from "./schema.js";

type Kind = "agent" | "harbor";

export interface AdmissionRequest {
  /** Stable across retries of the same wait, so a retried poll never takes a second slot. */
  readonly id: string;
  /** The provider account the sandbox runs on; its limit is shared by every worker. */
  readonly pool: string;
  readonly orgId: string;
  readonly kind: Kind;
  readonly workflowId: string;
  readonly workflowRunId: string;
}

/** Undefined limits are unbounded. */
export interface AdmissionLimits {
  /** Concurrent sandboxes on the request's provider account. */
  readonly pool?: number;
  /** Concurrent sandboxes per organization and kind, across every pool. */
  readonly org: Readonly<Partial<Record<Kind, number>>>;
  /** Concurrent Harbor verifications across every pool: the workers' Harbor slots. */
  readonly harbor?: number;
}

/**
 * A held slot outlives its workflow (14-day execution timeout): release is explicit, and
 * `sweep` drains the slots of executions that ended without releasing.
 */
const GRANT_TTL = sql`now() + interval '15 days'`;
/**
 * How long a slot stays held after its stage ended abnormally (cancelled, failed, or its
 * workflow terminated): its sandbox may still be running until the provider stops it. Managed
 * E2B sandboxes are capped at one hour, and a job reports within ten minutes after that.
 */
const DRAIN = sql`now() + interval '70 minutes'`;
/** Waiters poll at least every 30 s; one that stops polling leaves the queue. */
const WAIT_TTL = sql`now() + interval '2 minutes'`;
/** Serializes every admission decision; each takes a few milliseconds. */
const LOCK = sql`select pg_advisory_xact_lock(hashtext('selfbench:sandbox-admission'))`;

export type AdmissionStore = ReturnType<typeof createAdmissionStore>;

interface Row {
  id: string;
  pool: string;
  orgId: string;
  kind: Kind;
  grantedAt: Date | null;
  requestedAt: Date;
}

/**
 * Plays the pool's queue forward as slots free up. The next grant goes to the eligible waiter
 * whose organization holds the fewest of the pool's slots, oldest first, so one organization's
 * large batch cannot keep a later organization waiting behind all of its queued stages.
 */
function admitted(rows: Row[], request: AdmissionRequest, limits: AdmissionLimits): boolean {
  const held = rows.filter((row) => row.grantedAt);
  const inPool = (row: Row) => row.pool === request.pool;
  const orgKind = new Map<string, number>();
  const orgPool = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const row of held) {
    bump(orgKind, `${row.orgId}/${row.kind}`);
    if (inPool(row)) bump(orgPool, row.orgId);
  }
  let poolHeld = held.filter(inPool).length;
  let harborHeld = held.filter((row) => row.kind === "harbor").length;
  const eligible = (row: Row) =>
    (orgKind.get(`${row.orgId}/${row.kind}`) ?? 0) < (limits.org[row.kind] ?? Infinity) &&
    (row.kind !== "harbor" || harborHeld < (limits.harbor ?? Infinity));
  const before = (a: Row, b: Row) =>
    ((orgPool.get(a.orgId) ?? 0) - (orgPool.get(b.orgId) ?? 0) ||
      a.requestedAt.getTime() - b.requestedAt.getTime() ||
      a.id.localeCompare(b.id)) < 0;
  const waiting = rows.filter((row) => !row.grantedAt && inPool(row));
  while (poolHeld < (limits.pool ?? Infinity)) {
    let next: Row | undefined;
    for (const row of waiting) if (eligible(row) && (!next || before(row, next))) next = row;
    if (!next) return false;
    if (next.id === request.id) return true;
    waiting.splice(waiting.indexOf(next), 1);
    bump(orgKind, `${next.orgId}/${next.kind}`);
    bump(orgPool, next.orgId);
    poolHeld += 1;
    if (next.kind === "harbor") harborHeld += 1;
  }
  return false;
}

/**
 * Admission to shared provider accounts and Harbor capacity. Every decision runs under one
 * transaction advisory lock, so all worker replicas see one consistent count.
 */
export function createAdmissionStore(db: Database) {
  const table = sandboxAdmissions;
  return {
    /** True once `request` holds a slot; until then it waits in its pool's fair queue. */
    async acquire(request: AdmissionRequest, limits: AdmissionLimits): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx.execute(LOCK);
        await tx.delete(table).where(lt(table.expiresAt, sql`now()`));
        const rows: Row[] = await tx
          .select({
            id: table.id,
            pool: table.pool,
            orgId: table.orgId,
            kind: table.kind,
            grantedAt: table.grantedAt,
            requestedAt: table.requestedAt,
          })
          .from(table);
        const own = rows.find((row) => row.id === request.id);
        if (own?.grantedAt) return true;
        if (own)
          await tx.update(table).set({ expiresAt: WAIT_TTL }).where(eq(table.id, request.id));
        else {
          const [inserted] = await tx
            .insert(table)
            .values({ ...request, expiresAt: WAIT_TTL })
            .returning({ requestedAt: table.requestedAt });
          rows.push({
            ...request,
            grantedAt: null,
            requestedAt: inserted?.requestedAt ?? new Date(),
          });
        }
        if (!admitted(rows, request, limits)) return false;
        await tx
          .update(table)
          .set({ grantedAt: sql`now()`, expiresAt: GRANT_TTL })
          .where(eq(table.id, request.id));
        return true;
      });
    },
    /**
     * Frees a held slot or leaves the queue; releasing twice is harmless. A stage that did not
     * stop its own sandbox releases with `drain` and keeps a held slot until it has stopped.
     */
    async release(id: string, drain = false): Promise<void> {
      if (!drain) {
        await db.delete(table).where(eq(table.id, id));
        return;
      }
      await db.delete(table).where(and(eq(table.id, id), isNull(table.grantedAt)));
      await db
        .update(table)
        .set({ expiresAt: DRAIN })
        .where(and(eq(table.id, id), gt(table.expiresAt, DRAIN)));
    },
    /** Executions still holding undrained slots, for `drainEnded`. */
    async holders(): Promise<{ workflowId: string; workflowRunId: string }[]> {
      return db
        .selectDistinct({ workflowId: table.workflowId, workflowRunId: table.workflowRunId })
        .from(table)
        .where(and(isNotNull(table.grantedAt), gt(table.expiresAt, DRAIN)));
    },
    /** Drains the slots of an execution that ended without releasing them. */
    async drainEnded(workflowId: string, workflowRunId: string): Promise<void> {
      await db
        .update(table)
        .set({ expiresAt: DRAIN })
        .where(
          and(
            eq(table.workflowId, workflowId),
            eq(table.workflowRunId, workflowRunId),
            gt(table.expiresAt, DRAIN),
          ),
        );
    },
  };
}
