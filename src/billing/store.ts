import { and, eq, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { billingOutbox, billingWebhookEvents, orgBilling } from "../db/schema.js";
import { type BillingEligibility, eligibilityFrom } from "./eligibility.js";

export interface SubscriptionState {
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly status: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd?: Date;
}

export function createBillingStore(db: Database, configured: boolean) {
  return {
    async status(orgId: number): Promise<BillingEligibility> {
      const [row] = await db.select().from(orgBilling).where(eq(orgBilling.orgId, orgId));
      return eligibilityFrom(configured, row);
    },
    async customerId(orgId: number): Promise<string | undefined> {
      const [row] = await db
        .select({ customerId: orgBilling.stripeCustomerId })
        .from(orgBilling)
        .where(eq(orgBilling.orgId, orgId));
      return row?.customerId ?? undefined;
    },
    async saveCustomer(orgId: number, customerId: string): Promise<string> {
      const [row] = await db
        .insert(orgBilling)
        .values({ orgId, stripeCustomerId: customerId })
        .onConflictDoUpdate({
          target: orgBilling.orgId,
          set: { updatedAt: new Date() },
        })
        .returning({ customerId: orgBilling.stripeCustomerId });
      return row?.customerId ?? customerId;
    },
    async applyWebhook(event: { id: string; type: string }, state?: SubscriptionState) {
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(billingWebhookEvents)
          .values({ id: event.id, type: event.type })
          .onConflictDoNothing()
          .returning({ id: billingWebhookEvents.id });
        if (inserted.length === 0 || !state) return;
        const existing = await tx
          .select({ orgId: orgBilling.orgId })
          .from(orgBilling)
          .where(eq(orgBilling.stripeCustomerId, state.customerId));
        const orgId = existing[0]?.orgId;
        if (!orgId) throw new Error(`Stripe customer ${state.customerId} is not linked to an org`);
        await tx
          .update(orgBilling)
          .set({
            stripeSubscriptionId: state.subscriptionId,
            status: state.status,
            cancelAtPeriodEnd: state.cancelAtPeriodEnd,
            currentPeriodEnd: state.currentPeriodEnd ?? null,
            updatedAt: new Date(),
          })
          .where(eq(orgBilling.orgId, orgId));
      });
    },
    async claimDelivery(now = new Date()) {
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ id: billingOutbox.id })
          .from(billingOutbox)
          .where(
            and(
              or(
                eq(billingOutbox.status, "pending"),
                eq(billingOutbox.status, "failed"),
                eq(billingOutbox.status, "delivering"),
              ),
              lte(billingOutbox.nextAttemptAt, now),
            ),
          )
          .orderBy(billingOutbox.id)
          .limit(1);
        if (!candidate) return undefined;
        const [claimed] = await tx
          .update(billingOutbox)
          .set({
            status: "delivering",
            attempts: sql`${billingOutbox.attempts} + 1`,
            // A crashed sender makes this row retryable after the request timeout window.
            nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
          })
          .where(and(eq(billingOutbox.id, candidate.id), lte(billingOutbox.nextAttemptAt, now)))
          .returning();
        return claimed;
      });
    },
    async delivered(id: number) {
      await db
        .update(billingOutbox)
        .set({ status: "sent", sentAt: new Date(), lastError: null })
        .where(eq(billingOutbox.id, id));
    },
    async failed(id: number, attempts: number, error: unknown) {
      const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10));
      await db
        .update(billingOutbox)
        .set({
          status: "failed",
          lastError: String(error instanceof Error ? error.message : error).slice(0, 1000),
          nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
        })
        .where(eq(billingOutbox.id, id));
    },
  };
}

export type BillingStore = ReturnType<typeof createBillingStore>;
