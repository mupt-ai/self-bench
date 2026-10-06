import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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

/**
 * Public releases of a group, as `releases` holds them for a repository: append-only, a line per
 * workspace and group, no foreign keys. A line keeps the slug its first release claimed, so a
 * group's address on selfbench.dev never changes and no other line can take it.
 */
export const groupReleases = pgTable(
  "group_releases",
  {
    id: uuid("id").primaryKey(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    groupId: uuid("group_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    publisherLogin: text("publisher_login").notNull(),
    predecessorId: uuid("predecessor_id"),
    releasedBy: bigint("released_by", { mode: "number" }).notNull(),
    releasedByLogin: text("released_by_login").notNull(),
    releasedAt: timestamptz("released_at").notNull().defaultNow(),
    withdrawnAt: timestamptz("withdrawn_at"),
    withdrawnByLogin: text("withdrawn_by_login"),
    hash: text("hash").notNull(),
    payload: jsonb("payload").notNull(),
    detail: jsonb("detail").notNull(),
  },
  (table) => [
    index("group_releases_line_time").on(table.orgId, table.groupId, table.releasedAt),
    unique("group_releases_line_predecessor")
      .on(table.orgId, table.groupId, table.predecessorId)
      .nullsNotDistinct(),
    // Only a line's first row has no predecessor: one line per slug, for good.
    uniqueIndex("group_releases_slug")
      .on(sql`lower(${table.slug})`)
      .where(sql`${table.predecessorId} is null`),
  ],
);
