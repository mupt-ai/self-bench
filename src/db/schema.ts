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
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

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
    githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
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
  (table) => [index("repos_org_id").on(table.orgId)],
);

/** Pipeline runs whose candidates count as this repository's tasks (historical attachments). */
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
