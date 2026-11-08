import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ResourceLimits } from "../sandbox/resources.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Organization model and sandbox credentials. `secret` is the sealed JSON of the credential's
 * value (plus the Modal token ID or Vercel team/project); only the worker and create path open it.
 * `max_sandboxes`/`max_builds` limit its work at once; `resource_limits` is the most one of its
 * sandboxes may use (ResourceLimits); `models` are a custom endpoint's model IDs.
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
    maxSandboxes: integer("max_sandboxes"),
    maxBuilds: integer("max_builds"),
    resourceLimits: jsonb("resource_limits").$type<ResourceLimits>(),
    models: text("models").array(),
    secret: text("secret"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [index("credentials_org").on(table.orgId)],
);
