import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { generationUsage } from "../db/schema.js";
import type { RunUsageSummary, UsageRow } from "./usage.js";

/** Persists metered stage usage into the site database and sums it back per run. */
export interface UsageLedger {
  record(row: UsageRow): Promise<void>;
  summary(runId: string): Promise<RunUsageSummary>;
}

export function createUsageStore(db: Database): UsageLedger {
  return {
    async record(row) {
      await db.insert(generationUsage).values({
        runId: row.runId,
        orgId: row.orgId,
        stage: row.stage,
        managed: row.managed,
        sandboxSeconds: row.sandboxSeconds,
        ...(row.provider ? { provider: row.provider } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(row.tokens
          ? {
              inputTokens: row.tokens.input,
              outputTokens: row.tokens.output,
              cacheReadTokens: row.tokens.cacheRead,
              cacheWriteTokens: row.tokens.cacheWrite,
            }
          : {}),
        ...(row.modelCostUsd !== undefined ? { modelCostUsd: row.modelCostUsd } : {}),
        ...(row.sandboxCostUsd !== undefined ? { sandboxCostUsd: row.sandboxCostUsd } : {}),
      });
    },
    async summary(runId) {
      const [row] = await db
        .select({
          modelCostUsd: sql<number>`coalesce(sum(${generationUsage.modelCostUsd}), 0)::float8`,
          sandboxCostUsd: sql<number>`coalesce(sum(${generationUsage.sandboxCostUsd}), 0)::float8`,
          managedCostUsd: sql<number>`coalesce(sum(${generationUsage.modelCostUsd}) filter (where ${generationUsage.managed}) + coalesce(sum(${generationUsage.sandboxCostUsd}) filter (where ${generationUsage.managed}), 0), 0)::float8`,
          tokens: sql<number>`coalesce(sum(${generationUsage.inputTokens} + ${generationUsage.outputTokens} + ${generationUsage.cacheReadTokens} + ${generationUsage.cacheWriteTokens}), 0)::int`,
          sandboxSeconds: sql<number>`coalesce(sum(${generationUsage.sandboxSeconds}), 0)::int`,
        })
        .from(generationUsage)
        .where(eq(generationUsage.runId, runId));
      return (
        row ?? {
          modelCostUsd: 0,
          sandboxCostUsd: 0,
          managedCostUsd: 0,
          tokens: 0,
          sandboxSeconds: 0,
        }
      );
    },
  };
}
