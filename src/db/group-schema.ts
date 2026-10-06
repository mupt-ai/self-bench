import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { repos } from "./schema.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** A named set of a tenant's connected repositories, evaluated together with the same settings. */
export const repoGroups = pgTable(
  "repo_groups",
  {
    id: uuid("id").primaryKey(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("repo_groups_org_name").on(table.orgId, sql`lower(${table.name})`)],
);

/** Disconnecting a repository takes it out of its groups; past group evaluations keep it. */
export const repoGroupMembers = pgTable(
  "repo_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => repoGroups.id, { onDelete: "cascade" }),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    addedAt: timestamptz("added_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.repoId] })],
);

/**
 * One submission of the same settings to every repository of a group: a comparison per
 * repository, run and stored as any other. No foreign keys, so the record outlives its group.
 */
export const groupEvaluations = pgTable(
  "group_evaluations",
  {
    id: uuid("id").primaryKey(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    groupId: uuid("group_id").notNull(),
    groupName: text("group_name").notNull(),
    signature: text("signature").notNull(),
    /** Each member as submitted: its comparison, or why it was left out. */
    repos: jsonb("repos").notNull(),
    createdByLogin: text("created_by_login").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [index("group_evaluations_group").on(table.groupId, table.createdAt)],
);
