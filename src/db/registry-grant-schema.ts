import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Customers' pull grants for accepted tasks' images, until expired or revoked (registry-grants.ts). */
export const registryGrants = pgTable("registry_grants", {
  id: uuid("id").primaryKey(),
  label: text("label").notNull(),
  taskIds: jsonb("task_ids").$type<number[]>().notNull(),
  /** `<name>@sha256:…` in the task image repository. */
  images: jsonb("images").$type<string[]>().notNull(),
  /** Whether it also reaches the verifier images, which hold the tasks' tests. */
  withVerifier: boolean("with_verifier").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  expiresAt: timestamptz("expires_at").notNull(),
  revokedAt: timestamptz("revoked_at"),
});
