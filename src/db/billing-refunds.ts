import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { billingOutbox, billingRefunds } from "./schema.js";

export interface RefundInput {
  readonly orgId: number;
  readonly customerId: string;
  readonly adminUserId: number;
  readonly reason: string;
  readonly since: Date;
  readonly unitScale: number;
  readonly eventName: string;
}

/**
 * Hands back everything sent to Stripe for the org since `since` (the open period's start)
 * that an earlier refund has not already covered. Returns undefined when nothing is left.
 */
export async function refundSince(db: Database, input: RefundInput) {
  return db.transaction(async (tx) => {
    // Serializes refunds per org so two admins cannot both refund the same usage.
    await tx.execute(sql`select pg_advisory_xact_lock(887654322, ${input.orgId})`);
    const [outstanding] = await tx
      .select({ units: sql<number>`coalesce(sum(${billingOutbox.value}), 0)::float8` })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.orgId, input.orgId),
          eq(billingOutbox.customerId, input.customerId),
          gte(billingOutbox.createdAt, input.since),
        ),
      );
    const units = outstanding?.units ?? 0;
    if (units <= 0) return undefined;
    const [refund] = await tx
      .insert(billingRefunds)
      .values({
        orgId: input.orgId,
        adminUserId: input.adminUserId,
        reason: input.reason,
        units,
        unitScale: input.unitScale,
      })
      .returning();
    if (!refund) throw new Error("Refund insert failed");
    await tx.insert(billingOutbox).values({
      refundId: refund.id,
      orgId: input.orgId,
      identifier: `selfbench-refund-${refund.id}`,
      eventName: input.eventName,
      customerId: input.customerId,
      value: -units,
    });
    return refund;
  });
}
