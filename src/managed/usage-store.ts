import { eq, sql } from "drizzle-orm";
import { loadBillingPolicy } from "../billing/config.js";
import { modelBillableUnits, rateSnapshotSpec, sandboxBillableUnits } from "../billing/policy.js";
import type { Database } from "../db/client.js";
import { billingOutbox, billingRateSnapshots, generationUsage, orgBilling } from "../db/schema.js";
import type { RunUsageSummary, UsageRow } from "./usage.js";

/** Persists metered stage usage into the site database and sums it back per run. */
export interface UsageLedger {
  record(row: UsageRow): Promise<void>;
  summary(runId: string): Promise<RunUsageSummary>;
}

export interface UsageStoreOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

export function createUsageStore(db: Database, options: UsageStoreOptions = {}): UsageLedger {
  const spec = rateSnapshotSpec(loadBillingPolicy(options.environment));
  return {
    async record(row) {
      await db.transaction(async (tx) => {
        const snapshot = row.managed
          ? await tx
              .insert(billingRateSnapshots)
              .values(spec)
              .onConflictDoUpdate({
                target: billingRateSnapshots.configHash,
                set: { configHash: spec.configHash },
              })
              .returning()
              .then((rows) => rows[0])
          : undefined;
        const modelUnits =
          snapshot && row.managedModel ? modelBillableUnits(snapshot, row.model, row.tokens) : 0;
        const sandboxUnits =
          snapshot && row.managedSandbox
            ? sandboxBillableUnits(snapshot, row.sandboxSeconds, row.cpu, row.memoryMiB)
            : 0;
        const [usage] = await tx
          .insert(generationUsage)
          .values({
            runId: row.runId,
            orgId: row.orgId,
            stage: row.stage,
            managed: row.managed,
            managedModel: row.managedModel,
            managedSandbox: row.managedSandbox,
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
            ...(snapshot ? { rateSnapshotId: snapshot.id } : {}),
            modelBillableUnits: modelUnits,
            sandboxBillableUnits: sandboxUnits,
          })
          .returning({ id: generationUsage.id });
        const totalUnits = modelUnits + sandboxUnits;
        if (!usage || !snapshot || totalUnits <= 0) return;
        const [billing] = await tx
          .select({ customerId: orgBilling.stripeCustomerId })
          .from(orgBilling)
          .where(eq(orgBilling.orgId, row.orgId));
        if (!billing?.customerId) return;
        await tx.insert(billingOutbox).values({
          usageId: usage.id,
          orgId: row.orgId,
          identifier: `selfbench-usage-${usage.id}`,
          eventName: snapshot.meterEventName,
          customerId: billing.customerId,
          value: totalUnits,
        });
      });
    },
    async summary(runId) {
      const [row] = await db
        .select({
          modelCostUsd: sql<number | null>`sum(${generationUsage.modelCostUsd})::float8`,
          sandboxCostUsd: sql<number | null>`sum(${generationUsage.sandboxCostUsd})::float8`,
          managedCostUsd: sql<number>`coalesce(sum(${generationUsage.modelCostUsd}) filter (where ${generationUsage.managed}) + coalesce(sum(${generationUsage.sandboxCostUsd}) filter (where ${generationUsage.managed}), 0), 0)::float8`,
          modelInputTokens: sql<number>`coalesce(sum(${generationUsage.inputTokens}), 0)::int`,
          modelOutputTokens: sql<number>`coalesce(sum(${generationUsage.outputTokens}), 0)::int`,
          modelCacheReadTokens: sql<number>`coalesce(sum(${generationUsage.cacheReadTokens}), 0)::int`,
          modelCacheWriteTokens: sql<number>`coalesce(sum(${generationUsage.cacheWriteTokens}), 0)::int`,
          tokens: sql<number>`coalesce(sum(${generationUsage.inputTokens} + ${generationUsage.outputTokens} + ${generationUsage.cacheReadTokens} + ${generationUsage.cacheWriteTokens}), 0)::int`,
          sandboxSeconds: sql<number>`coalesce(sum(${generationUsage.sandboxSeconds}), 0)::int`,
        })
        .from(generationUsage)
        .where(eq(generationUsage.runId, runId));
      return row
        ? {
            modelCostUsd: row.modelCostUsd ?? undefined,
            sandboxCostUsd: row.sandboxCostUsd ?? undefined,
            managedCostUsd: row.managedCostUsd,
            modelTokens: {
              input: row.modelInputTokens,
              output: row.modelOutputTokens,
              cacheRead: row.modelCacheReadTokens,
              cacheWrite: row.modelCacheWriteTokens,
            },
            tokens: row.tokens,
            sandboxSeconds: row.sandboxSeconds,
          }
        : {
            modelCostUsd: undefined,
            sandboxCostUsd: undefined,
            managedCostUsd: 0,
            modelTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            tokens: 0,
            sandboxSeconds: 0,
          };
    },
  };
}
