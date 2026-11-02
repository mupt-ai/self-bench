import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgs } from "./schema.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Repository groups: a workspace's named set of its connected repositories, evaluated together
 * like one repository. Its runs are its own (EvaluationScope's `groupId`), over its members'
 * approved tasks, and its releases are its own too (`group_releases`).
 */
export const repositoryGroups = pgTable(
  "repository_groups",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** The group's address in the app and on selfbench.dev. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Members' GitHub repository ids, in the order pages list them. */
    repositoryIds: jsonb("repository_ids").$type<number[]>().notNull(),
    updatedByLogin: text("updated_by_login").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("repository_groups_org_slug").on(table.orgId, table.slug)],
);

/** A group's run summaries, as `evaluation_summaries` keeps a repository's. */
export const groupSummaries = pgTable(
  "group_summaries",
  {
    groupId: bigint("group_id", { mode: "number" })
      .notNull()
      .references(() => repositoryGroups.id, { onDelete: "cascade" }),
    id: uuid("id").notNull(),
    revision: integer("revision").notNull(),
    body: text("body").notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.id] })],
);

/**
 * A group's public releases, append-only like `releases`: a line is one group, its current
 * release the newest row not withdrawn. No foreign keys, so deleting the group never touches
 * what was published; `payload` is what the public API serves, `detail` is private.
 */
export const groupReleases = pgTable(
  "group_releases",
  {
    id: uuid("id").primaryKey(),
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    /** The group's address and the workspace's login when released: its page's address. */
    slug: text("slug").notNull(),
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
    index("group_releases_line_time").on(table.groupId, table.releasedAt),
    index("group_releases_address").on(sql`lower(${table.publisherLogin})`, table.slug),
    unique("group_releases_line_predecessor")
      .on(table.groupId, table.predecessorId)
      .nullsNotDistinct(),
  ],
);
