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
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const evaluationRecords = pgTable("evaluation_records", {
  path: text("path").primaryKey(),
  version: integer("version").notNull(),
  sealed: text("sealed").notNull(),
});

/** GitHub accounts that have signed in. The token is sealed; a database read alone is useless. */
export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
    login: text("login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    githubToken: text("github_token").notNull(),
    githubScopes: text("github_scopes").notNull().default(""),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (table) => [index("users_login").on(table.login)],
);

/** A tenant: a GitHub organization, or a user's personal account (kind = "user"). */
export const orgs = pgTable(
  "orgs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
    login: text("login").notNull(),
    kind: text("kind", { enum: ["org", "user"] }).notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("orgs_login").on(table.login)],
);

/** Refreshed from GitHub on every sign-in; the site trusts this, not a live call. */
export const orgMembers = pgTable(
  "org_members",
  {
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    syncedAt: timestamptz("synced_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("org_members_pk").on(table.orgId, table.userId),
    index("org_members_user_id").on(table.userId),
  ],
);

/** A repository connected to a tenant; tasks accumulate under it as pull requests merge. */
export const repos = pgTable(
  "repos",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    githubId: bigint("github_id", { mode: "number" }).notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    private: boolean("private").notNull().default(false),
    /** Opt-in: keep building tasks as pull requests merge, rather than only on demand. */
    continuous: boolean("continuous").notNull().default(false),
    connectedBy: bigint("connected_by", { mode: "number" })
      .notNull()
      .references(() => users.id),
    connectedAt: timestamptz("connected_at").notNull().defaultNow(),
  },
  (table) => [
    index("repos_org_id").on(table.orgId),
    uniqueIndex("repos_org_github_id").on(table.orgId, table.githubId),
  ],
);

/** Repository ownership for batch generation, including batches with no candidates yet. */
export const repoRuns = pgTable(
  "repo_runs",
  {
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    attachedBy: bigint("attached_by", { mode: "number" })
      .notNull()
      .references(() => users.id),
    attachedAt: timestamptz("attached_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("repo_runs_pk").on(table.repoId, table.runId)],
);

/** One row per candidate the pipeline processed; files and artifacts stay in the bucket. */
export const tasks = pgTable(
  "tasks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    /** The agent's name for the task; display only, it can change between rounds. */
    taskId: text("task_id").notNull(),
    /** (repo_id, source_pr) is the identity across runs. */
    sourcePr: integer("source_pr"),
    sourceUrl: text("source_url"),
    difficulty: text("difficulty", { enum: ["easy", "medium", "hard"] }).notNull(),
    pipelineStatus: text("pipeline_status", {
      enum: ["in_progress", "accepted", "rejected", "infrastructure_failed"],
    }).notNull(),
    stage: text("stage").notNull(),
    round: integer("round"),
    reason: text("reason"),
    bundleKey: text("bundle_key"),
    definition: jsonb("definition").$type<Record<string, unknown>>(),
    reviewDecision: text("review_decision", { enum: ["approve", "reject"] }),
    reviewNote: text("review_note"),
    reviewedBy: bigint("reviewed_by", { mode: "number" }).references(() => users.id),
    reviewedAt: timestamptz("reviewed_at"),
    /** Set when the site started this task itself. */
    workflowId: text("workflow_id"),
    startedBy: bigint("started_by", { mode: "number" }).references(() => users.id),
    startedAt: timestamptz("started_at"),
    /** Retained across sync and run detachment; artifacts and historical results stay intact. */
    deletedAt: timestamptz("deleted_at"),
    syncedAt: timestamptz("synced_at").notNull().defaultNow(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tasks_run_candidate").on(table.runId, table.candidateId),
    uniqueIndex("tasks_workflow_id").on(table.workflowId),
    index("tasks_repo_id").on(table.repoId),
    index("tasks_repo_pr").on(table.repoId, table.sourcePr),
  ],
);

/** Personal API keys. Only a SHA-256 of the secret is stored; the secret is shown once at creation. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The first characters of the secret, so a key can be recognised without revealing it. */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scope: text("scope", { enum: ["read", "write"] }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    lastUsedAt: timestamptz("last_used_at"),
    revokedAt: timestamptz("revoked_at"),
  },
  (table) => [index("api_keys_user_id").on(table.userId)],
);

/** Application-owned batch bookkeeping, not a Temporal parent execution. */
export const generationBatches = pgTable("generation_batches", {
  runId: text("run_id").primaryKey(),
  state: jsonb("state").$type<import("../generation/batches/types.js").GenerationBatch>().notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

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
