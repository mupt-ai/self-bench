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
import type { SavedHarnessDraft } from "../contracts/saved-harnesses.js";
import { orgs, users } from "./schema.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * A saved harness: a workspace's named change to one agent (skills, instructions, options, a
 * subagent model with its delegation prompt and credential), which a comparison in any of its
 * repositories or benchmarks picks by id (contracts/saved-harnesses.ts). A comparison freezes what
 * it picked, so editing or deleting one changes no run that already used it.
 */
export const savedHarnesses = pgTable(
  "saved_harnesses",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Everything it changes but its name, as savedHarnessSchema parsed it. */
    changes: jsonb("changes").$type<Omit<SavedHarnessDraft, "name">>().notNull(),
    createdBy: bigint("created_by", { mode: "number" }).references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("saved_harnesses_org_name").on(table.orgId, sql`lower(${table.name})`)],
);
