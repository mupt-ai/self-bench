import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { orgs } from "./schema.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export interface BillingModelRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Integer rates frozen when usage was recorded, so later catalog changes cannot rewrite invoices. */
export const billingRateSnapshots = pgTable("billing_rate_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  configHash: text("config_hash").notNull().unique(),
  policyVersion: text("policy_version").notNull(),
  unitScale: integer("unit_scale").notNull(),
  markupBps: integer("markup_bps").notNull(),
  meterEventName: text("meter_event_name").notNull(),
  modelRates: jsonb("model_rates").$type<Record<string, BillingModelRates>>().notNull(),
  vcpuUnitsPerSecond: integer("vcpu_units_per_second").notNull(),
  gibUnitsPerSecond: integer("gib_units_per_second").notNull(),
});

/**
 * One metered generation stage's platform usage (model tokens, sandbox seconds, estimated
 * cost). Only managed resources are recorded: usage on an organization's own credentials is
 * billed by the provider, not by SelfBench. USD columns are estimates; billable units come
 * from the rate snapshot.
 */
export const generationUsage = pgTable(
  "generation_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id").notNull(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    stage: text("stage").notNull(),
    managed: boolean("managed").notNull(),
    managedModel: boolean("managed_model").notNull().default(false),
    managedSandbox: boolean("managed_sandbox").notNull().default(false),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    modelCostUsd: doublePrecision("model_cost_usd"),
    sandboxSeconds: integer("sandbox_seconds").notNull(),
    sandboxCostUsd: doublePrecision("sandbox_cost_usd"),
    /** Frozen integer rates used to compute billable units; estimates stay in the USD columns. */
    rateSnapshotId: bigint("rate_snapshot_id", { mode: "number" }).references(
      () => billingRateSnapshots.id,
    ),
    modelBillableUnits: bigint("model_billable_units", { mode: "number" }).notNull().default(0),
    sandboxBillableUnits: bigint("sandbox_billable_units", { mode: "number" }).notNull().default(0),
    recordedAt: timestamptz("recorded_at").notNull().defaultNow(),
  },
  (table) => [index("generation_usage_run_id").on(table.runId)],
);

/** Per-organization Stripe customer and subscription. Absent row means billing was never started. */
export const orgBilling = pgTable("org_billing", {
  orgId: bigint("org_id", { mode: "number" })
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: text("status").notNull().default("none"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  currentPeriodEnd: timestamptz("current_period_end"),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/** Meter events to send to Stripe; written in the usage transaction, delivered by the API. */
export const billingOutbox = pgTable(
  "billing_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    usageId: bigint("usage_id", { mode: "number" })
      .notNull()
      .references(() => generationUsage.id)
      .unique(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    identifier: text("identifier").notNull().unique(),
    eventName: text("event_name").notNull(),
    customerId: text("customer_id").notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
    status: text("status", { enum: ["pending", "delivering", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    sentAt: timestamptz("sent_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [index("billing_outbox_delivery").on(table.status, table.nextAttemptAt)],
);

/** Stripe event ids already applied, so webhook retries do not double-apply subscription state. */
export const billingWebhookEvents = pgTable("billing_webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamptz("processed_at").notNull().defaultNow(),
});
