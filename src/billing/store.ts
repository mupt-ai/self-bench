import { and, eq, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { billingOutbox, billingWebhookEvents, generationUsage, orgBilling } from "../db/schema.js";
import { type BillingEligibility, eligibilityFrom } from "./eligibility.js";

export interface BillingUsageSummary {
  readonly modelTokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly tokens: number;
  readonly modelCostUsd: number | undefined;
  readonly sandboxSeconds: number;
  readonly sandboxCostUsd: number | undefined;
}

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
    async usage(orgId: number): Promise<BillingUsageSummary> {
      const [row] = await db
        .select({
          input: sql<number>`coalesce(sum(${generationUsage.inputTokens}), 0)::int`,
          output: sql<number>`coalesce(sum(${generationUsage.outputTokens}), 0)::int`,
          cacheRead: sql<number>`coalesce(sum(${generationUsage.cacheReadTokens}), 0)::int`,
          cacheWrite: sql<number>`coalesce(sum(${generationUsage.cacheWriteTokens}), 0)::int`,
          modelCostUsd: sql<number | null>`sum(${generationUsage.modelCostUsd})::float8`,
          sandboxSeconds: sql<number>`coalesce(sum(${generationUsage.sandboxSeconds}), 0)::int`,
          sandboxCostUsd: sql<number | null>`sum(${generationUsage.sandboxCostUsd})::float8`,
        })
        .from(generationUsage)
        .where(eq(generationUsage.orgId, orgId));
      const modelTokens = {
        input: row?.input ?? 0,
        output: row?.output ?? 0,
        cacheRead: row?.cacheRead ?? 0,
        cacheWrite: row?.cacheWrite ?? 0,
      };
      return {
        modelTokens,
        tokens: Object.values(modelTokens).reduce((total, value) => total + value, 0),
        modelCostUsd: row?.modelCostUsd ?? undefined,
        sandboxSeconds: row?.sandboxSeconds ?? 0,
        sandboxCostUsd: row?.sandboxCostUsd ?? undefined,
      };
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
    async delivered(id: number, attempts: number) {
      await db
        .update(billingOutbox)
        .set({ status: "sent", sentAt: new Date(), lastError: null })
        .where(
          and(
            eq(billingOutbox.id, id),
            eq(billingOutbox.status, "delivering"),
            eq(billingOutbox.attempts, attempts),
          ),
        );
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
        .where(
          and(
            eq(billingOutbox.id, id),
            eq(billingOutbox.status, "delivering"),
            eq(billingOutbox.attempts, attempts),
          ),
        );
    },
  };
}

export type BillingStore = ReturnType<typeof createBillingStore>;
