import { and, eq, lte, or, sql } from "drizzle-orm";
import { type BillingEligibility, eligibilityFrom } from "../generation/billing/eligibility.js";
import { type RefundInput, refundSince } from "./billing-refunds.js";
import type { Database } from "./client.js";
import {
  billingCreditGrants,
  billingOutbox,
  billingRateSnapshots,
  billingRefunds,
  billingWebhookEvents,
  generationUsage,
  orgBilling,
  orgs,
} from "./schema.js";

export class CreditGrantConflictError extends Error {
  constructor() {
    super("Credit grant request ID was already used with different details");
  }
}

export class CreditGrantLimitError extends Error {
  constructor() {
    super("Global credit grant daily limit of $100 exceeded");
  }
}

export interface BillingUsageSummary {
  readonly modelTokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly tokens: number;
  readonly modelBillableUsd: number;
  readonly sandboxSeconds: number;
  readonly sandboxBillableUsd: number;
  /** The part of the billable amount sent to Stripe; usage from before billing was set up is not. */
  readonly billedUsd: number;
  readonly refundedUsd: number;
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
          input: sql<number>`coalesce(sum(${generationUsage.inputTokens}) filter (where ${generationUsage.managedModel}), 0)::int`,
          output: sql<number>`coalesce(sum(${generationUsage.outputTokens}) filter (where ${generationUsage.managedModel}), 0)::int`,
          cacheRead: sql<number>`coalesce(sum(${generationUsage.cacheReadTokens}) filter (where ${generationUsage.managedModel}), 0)::int`,
          cacheWrite: sql<number>`coalesce(sum(${generationUsage.cacheWriteTokens}) filter (where ${generationUsage.managedModel}), 0)::int`,
          modelBillableUsd: sql<number>`coalesce(sum(${generationUsage.modelBillableUnits}::float8 / nullif(${billingRateSnapshots.unitScale}, 0)) filter (where ${generationUsage.managedModel}), 0)::float8`,
          sandboxSeconds: sql<number>`coalesce(sum(${generationUsage.sandboxSeconds}) filter (where ${generationUsage.managedSandbox}), 0)::int`,
          sandboxBillableUsd: sql<number>`coalesce(sum(${generationUsage.sandboxBillableUnits}::float8 / nullif(${billingRateSnapshots.unitScale}, 0)) filter (where ${generationUsage.managedSandbox}), 0)::float8`,
          billedUsd: sql<number>`coalesce(sum(${billingOutbox.value}::float8 / nullif(${billingRateSnapshots.unitScale}, 0)), 0)::float8`,
        })
        .from(generationUsage)
        .leftJoin(billingRateSnapshots, eq(generationUsage.rateSnapshotId, billingRateSnapshots.id))
        .leftJoin(billingOutbox, eq(billingOutbox.usageId, generationUsage.id))
        .where(eq(generationUsage.orgId, orgId));
      const [refunds] = await db
        .select({
          usd: sql<number>`coalesce(sum(${billingRefunds.units}::float8 / ${billingRefunds.unitScale}), 0)::float8`,
        })
        .from(billingRefunds)
        .where(eq(billingRefunds.orgId, orgId));
      const modelTokens = {
        input: row?.input ?? 0,
        output: row?.output ?? 0,
        cacheRead: row?.cacheRead ?? 0,
        cacheWrite: row?.cacheWrite ?? 0,
      };
      return {
        modelTokens,
        tokens: Object.values(modelTokens).reduce((total, value) => total + value, 0),
        modelBillableUsd: row?.modelBillableUsd ?? 0,
        sandboxSeconds: row?.sandboxSeconds ?? 0,
        sandboxBillableUsd: row?.sandboxBillableUsd ?? 0,
        billedUsd: row?.billedUsd ?? 0,
        refundedUsd: refunds?.usd ?? 0,
      };
    },
    refundSince: (input: RefundInput) => refundSince(db, input),
    async beginCreditGrant(input: {
      requestId: string;
      adminUserId: number;
      targetOrgId: number;
      amountCents: number;
      reason: string;
      customerId: string;
    }) {
      return db.transaction(async (tx) => {
        // One global lock/cap prevents multiple admins from multiplying the daily grant budget.
        await tx.execute(sql`select pg_advisory_xact_lock(887654321, 0)`);
        const [existing] = await tx
          .select()
          .from(billingCreditGrants)
          .where(eq(billingCreditGrants.requestId, input.requestId));
        if (existing) {
          if (
            existing.adminUserId !== input.adminUserId ||
            existing.targetOrgId !== input.targetOrgId ||
            existing.amountCents !== input.amountCents ||
            existing.reason !== input.reason ||
            existing.stripeCustomerId !== input.customerId
          )
            throw new CreditGrantConflictError();
          return { ...existing, replay: true };
        }
        const [daily] = await tx
          .select({
            amount: sql<number>`coalesce(sum(${billingCreditGrants.amountCents}), 0)::int`,
          })
          .from(billingCreditGrants)
          .where(and(sql`${billingCreditGrants.createdAt} >= date_trunc('day', now())`));
        if ((daily?.amount ?? 0) + input.amountCents > 10_000) {
          throw new CreditGrantLimitError();
        }
        const [inserted] = await tx
          .insert(billingCreditGrants)
          .values({
            requestId: input.requestId,
            adminUserId: input.adminUserId,
            targetOrgId: input.targetOrgId,
            amountCents: input.amountCents,
            reason: input.reason,
            stripeCustomerId: input.customerId,
          })
          .returning();
        if (!inserted) throw new Error("Credit grant reservation failed");
        return { ...inserted, replay: false };
      });
    },
    async finishCreditGrant(requestId: string, transactionId: string) {
      await db
        .update(billingCreditGrants)
        .set({ stripeTransactionId: transactionId })
        .where(
          and(
            eq(billingCreditGrants.requestId, requestId),
            sql`${billingCreditGrants.stripeTransactionId} is null`,
          ),
        );
    },
    async creditTarget(
      login: string,
    ): Promise<{ orgId: number; customerId: string; subscriptionId?: string } | undefined> {
      const [target] = await db
        .select({
          orgId: orgBilling.orgId,
          customerId: orgBilling.stripeCustomerId,
          subscriptionId: orgBilling.stripeSubscriptionId,
        })
        .from(orgBilling)
        .innerJoin(orgs, eq(orgBilling.orgId, orgs.id))
        .where(and(sql`lower(${orgs.login}) = lower(${login})`, eq(orgs.kind, "org")));
      return target?.customerId
        ? {
            orgId: target.orgId,
            customerId: target.customerId,
            ...(target.subscriptionId ? { subscriptionId: target.subscriptionId } : {}),
          }
        : undefined;
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
