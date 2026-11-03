import {
  bigint,
  bigserial,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgs } from "./schema.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Repository groups: a workspace's named set of its connected repositories, evaluated together
 * like one repository. Its runs are its own (EvaluationScope's `groupId`), over its members'
 * approved tasks, and its releases are a line of `releases` (`group_id`).
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
