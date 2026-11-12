import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgs, users } from "./schema.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * A GitHub account (organization or user) attached to a workspace. An account belongs to at most
 * one workspace. Members of a connected GitHub organization join its workspace at sign-in, and
 * leave it when GitHub no longer lists them.
 */
export const githubConnections = pgTable(
  "github_connections",
  {
    githubId: bigint("github_id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    login: text("login").notNull(),
    kind: text("kind", { enum: ["org", "user"] }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("github_connections_org_id").on(table.orgId)],
);

/** A pending invitation of a GitHub login to a workspace, accepted at that user's next sign-in. */
export const orgInvites = pgTable(
  "org_invites",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    githubLogin: text("github_login").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    invitedBy: bigint("invited_by", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("org_invites_org_login").on(table.orgId, sql`lower(${table.githubLogin})`),
    index("org_invites_login").on(sql`lower(${table.githubLogin})`),
  ],
);

/**
 * Who belongs to a workspace. `source` "github" rows come from a connected GitHub organization and
 * are removed at sign-in once GitHub stops listing the user, unless they were also invited; "invite"
 * rows were added in SelfBench and stay until removed there. Roles are SelfBench's: GitHub's only seeds a new row.
 */
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
    source: text("source", { enum: ["github", "invite"] })
      .notNull()
      .default("github"),
    /** Invited at some point: when GitHub stops listing them they stay, as an invited member. */
    invited: boolean("invited").notNull().default(false),
    syncedAt: timestamptz("synced_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("org_members_pk").on(table.orgId, table.userId),
    index("org_members_user_id").on(table.userId),
  ],
);
