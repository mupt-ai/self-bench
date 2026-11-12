import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { SavedConditionDraft } from "../contracts/conditions.js";
import { orgs, users } from "./schema.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * A saved condition: a workspace's named set of harness changes (skills, instructions, harness
 * options, a subagent model and its delegation prompt), which a comparison in any of its
 * repositories or benchmarks picks by id (contracts/conditions.ts). A comparison freezes what it
 * picked, so editing or deleting one changes no run that already used it.
 */
export const savedConditions = pgTable(
  "saved_conditions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Everything it changes but its name, as savedConditionSchema parsed it. */
    changes: jsonb("changes").$type<Omit<SavedConditionDraft, "name">>().notNull(),
    createdBy: bigint("created_by", { mode: "number" }).references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("saved_conditions_org_name").on(table.orgId, sql`lower(${table.name})`)],
);
