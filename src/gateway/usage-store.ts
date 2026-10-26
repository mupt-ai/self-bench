import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { gatewayRequests } from "../db/schema.js";
import type { GatewayUsage } from "./platform.js";

/** Where the gateway's per-call usage lands, and the per-trial totals read back from it. */
export function createGatewayUsageStore(db: Database) {
  return {
    async record(usage: GatewayUsage): Promise<void> {
      await db
        .insert(gatewayRequests)
        .values({
          requestId: usage.requestId,
          orgId: usage.orgId,
          credentialId: usage.credentialId,
          model: usage.model,
          tags: { ...usage.tags },
          status: usage.status,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: usage.costUsd,
          costSource: usage.costSource,
        })
        .onConflictDoNothing();
    },
    /**
     * A trial's total cost, and whether every call was priced: undefined when it made no calls
     * through the gateway.
     */
    async trialCost(
      orgId: number,
      trial: string,
    ): Promise<{ costUsd: number; complete: boolean } | undefined> {
      const [row] = await db
        .select({
          calls: sql<number>`count(*)::int`,
          costUsd: sql<number>`coalesce(sum(${gatewayRequests.costUsd}), 0)::float8`,
          unpriced: sql<number>`count(*) filter (where ${gatewayRequests.costUsd} is null)::int`,
        })
        .from(gatewayRequests)
        .where(
          sql`${gatewayRequests.orgId} = ${orgId} and ${gatewayRequests.tags}->>'trial' = ${trial}`,
        );
      if (!row?.calls) return undefined;
      return { costUsd: row.costUsd, complete: row.unpriced === 0 };
    },
  };
}
