import { type AnyColumn, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { gatewayRequests } from "../db/schema.js";
import type { GatewayUsage } from "./platform.js";

/** One model's share of a trial's solver calls: how many used tokens, and the tokens they used. */
export interface TrialModelUsage {
  /** The gateway's id for the model, `provider/model`. */
  readonly model: string;
  readonly calls: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

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
     * A trial's solver's total cost (its judge's calls aside), and whether every call was priced:
     * undefined when it made no calls through the gateway.
     */
    async trialCost(
      orgId: number,
      trial: string,
    ): Promise<{ costUsd: number; complete: boolean } | undefined> {
      const [row] = await db
        .select({
          calls: sql<number>`count(*)::int`,
          costUsd: sql<number>`coalesce(sum(${gatewayRequests.costUsd}), 0)::float8`,
          // A call refused before it reached the provider used no tokens, and cost nothing.
          unpriced: sql<number>`count(*) filter (where ${gatewayRequests.costUsd} is null
            and coalesce(${gatewayRequests.inputTokens}, 0) + coalesce(${gatewayRequests.outputTokens}, 0) > 0)::int`,
        })
        .from(gatewayRequests)
        .where(
          sql`${gatewayRequests.orgId} = ${orgId} and ${gatewayRequests.tags}->>'trial' = ${trial}
            and ${gatewayRequests.tags}->>'judge' is null`,
        );
      if (!row?.calls) return undefined;
      return { costUsd: row.costUsd, complete: row.unpriced === 0 };
    },
    /**
     * The tokens a trial's solver used on each model it called (its judge's calls aside), from the
     * calls that used any: a run with a subagent model has two.
     */
    async trialModels(orgId: number, trial: string): Promise<TrialModelUsage[]> {
      const tokens = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)::float8`;
      return await db
        .select({
          model: gatewayRequests.model,
          calls: sql<number>`count(*)::int`,
          input: tokens(gatewayRequests.inputTokens),
          output: tokens(gatewayRequests.outputTokens),
          cacheRead: tokens(gatewayRequests.cacheReadTokens),
          cacheWrite: tokens(gatewayRequests.cacheWriteTokens),
        })
        .from(gatewayRequests)
        .where(
          sql`${gatewayRequests.orgId} = ${orgId} and ${gatewayRequests.tags}->>'trial' = ${trial}
            and ${gatewayRequests.tags}->>'judge' is null
            and coalesce(${gatewayRequests.inputTokens}, 0) + coalesce(${gatewayRequests.outputTokens}, 0)
              + coalesce(${gatewayRequests.cacheReadTokens}, 0) + coalesce(${gatewayRequests.cacheWriteTokens}, 0) > 0`,
        )
        .groupBy(gatewayRequests.model);
    },
  };
}
