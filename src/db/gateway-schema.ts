import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Each model call SelfBench's gateway served (src/gateway/), with its usage and what it cost: the
 * provider's billed amount when it reports one, else the model's list price. A trial's cost is the
 * sum of its rows (`tags.trial`).
 */
export const gatewayRequests = pgTable(
  "gateway_requests",
  {
    requestId: text("request_id").primaryKey(),
    orgId: bigint("org_id", { mode: "number" }).notNull(),
    /** The credential's UUID, or `managed-model` for SelfBench's own OpenRouter key. */
    credentialId: text("credential_id").notNull(),
    /** The gateway's model id, `provider/model`. */
    model: text("model").notNull(),
    tags: jsonb("tags").$type<Record<string, string>>().notNull(),
    status: text("status", {
      enum: ["completed", "provider_error", "selector_error", "aborted"],
    }).notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: doublePrecision("cost_usd"),
    costSource: text("cost_source", { enum: ["provider", "pricing"] }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("gateway_requests_trial").on(sql`(${table.tags}->>'trial')`),
    index("gateway_requests_org_created").on(table.orgId, table.createdAt),
  ],
);
