import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Repository groups: a workspace's named set of its released repositories, shown on
 * selfbench.dev as one pooled leaderboard at /groups/<publisher>/<slug>. A group holds no
 * results of its own: its page is built from each member's current release by the same
 * workspace, so a release or withdrawal of a member changes the group at once. No foreign keys,
 * like `releases`: disconnecting a repository never touches what was published.
 */
export const releaseGroups = pgTable(
  "release_groups",
  {
    id: uuid("id").primaryKey(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    /** The workspace's login when the group was last saved: the page's address. */
    publisherLogin: text("publisher_login").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Members' GitHub repository ids, in the order the page lists them. */
    repositoryIds: jsonb("repository_ids").$type<number[]>().notNull(),
    updatedByLogin: text("updated_by_login").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("release_groups_org_slug").on(table.orgId, table.slug),
    index("release_groups_publisher_slug").on(sql`lower(${table.publisherLogin})`, table.slug),
  ],
);
