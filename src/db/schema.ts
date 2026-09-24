import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const evaluationRecords = pgTable("evaluation_records", {
  path: text("path").primaryKey(),
  version: integer("version").notNull(),
  sealed: text("sealed").notNull(),
});

/**
 * Organization model and sandbox credentials. `secret` is the sealed JSON of the credential's
 * value (plus the Modal token ID or Vercel team/project); only the worker and create path open it.
 */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    auth: text("auth").notNull(),
    endpoint: text("endpoint"),
    secret: text("secret"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [index("credentials_org").on(table.orgId)],
);

/** A saved evaluation comparison: the expanded per-model inputs the worker runs. */
export const comparisons = pgTable(
  "comparisons",
  {
    id: uuid("id").primaryKey(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    signature: text("signature").notNull(),
    inputs: jsonb("inputs").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [index("comparisons_repo").on(table.repoId)],
);

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

/**
 * Sandbox admission: one row per sandbox a workflow is waiting to start or holds on a shared
 * provider account. Granted rows count against the pool's limit until released or expired; a
 * stage that ended abnormally keeps its row until its sandbox has certainly stopped. Waiting
 * rows are granted oldest first, and each poll extends their short expiry, so a workflow that
 * stops polling drops out of the queue.
 */
export const sandboxAdmissions = pgTable(
  "sandbox_admissions",
  {
    id: text("id").primaryKey(),
    pool: text("pool").notNull(),
    orgId: text("org_id").notNull(),
    kind: text("kind").$type<"agent" | "harbor">().notNull(),
    /** The workflow execution waiting or holding, so a sweep can free a terminated one. */
    workflowId: text("workflow_id").notNull(),
    workflowRunId: text("workflow_run_id").notNull(),
    grantedAt: timestamptz("granted_at"),
    requestedAt: timestamptz("requested_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [index("sandbox_admissions_pool").on(table.pool, table.grantedAt)],
);

/**
 * Public releases: append-only snapshots a workspace published for a public repository. A
 * line is one workspace plus one GitHub repository id; its current release is the newest row
 * not withdrawn. No foreign keys, so disconnecting a repository or deleting tasks never
 * touches what was published. `payload` is what the public API serves; `detail` is private.
 */
export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    fullName: text("full_name").notNull(),
    publisherLogin: text("publisher_login").notNull(),
    /** The line's head when this row was written; null for a line's first release. */
    predecessorId: uuid("predecessor_id"),
    releasedBy: bigint("released_by", { mode: "number" }).notNull(),
    releasedByLogin: text("released_by_login").notNull(),
    releasedAt: timestamptz("released_at").notNull().defaultNow(),
    withdrawnAt: timestamptz("withdrawn_at"),
    withdrawnByLogin: text("withdrawn_by_login"),
    /** SHA-256 over the published results; an identical release inserts no row. */
    hash: text("hash").notNull(),
    payload: jsonb("payload").notNull(),
    detail: jsonb("detail").notNull(),
  },
  (table) => [
    index("releases_line_time").on(table.orgId, table.githubRepoId, table.releasedAt),
    index("releases_full_name").on(sql`lower(${table.fullName})`),
    // Only one successor per row, and only one first release per line.
    unique("releases_line_predecessor")
      .on(table.orgId, table.githubRepoId, table.predecessorId)
      .nullsNotDistinct(),
  ],
);

export * from "./billing-schema.js";
