import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { RunRequest } from "../../contracts/index.js";
import { createBatchStore } from "../../db/batches.js";
import type { Database } from "../../db/client.js";
import type { EncryptedRecordStore } from "../../db/encrypted-records.js";
import { createUsageStore } from "../../db/usage.js";
import { generationCost } from "../managed/cost-status.js";
import { loadDiscoveryShards, mergeDiscoveryShards } from "../runs/discovery-shards.js";
import { liveBatchStatus, overlayCandidateActivity } from "./activity.js";
import { advanceBatch } from "./advance.js";
import { exportBatch } from "./export.js";
import { prepareGenerationBatch } from "./prepare.js";
import { batchStatus } from "./status.js";
import { batchExecutions } from "./temporal.js";
import type { GenerationBatch } from "./types.js";

/** A restartable application reconciler, not a Temporal orchestration workflow. */
export function createGenerationBatches(
  db: Database,
  client: Client,
  artifacts: ArtifactStore,
  taskQueue: string,
  records?: EncryptedRecordStore,
) {
  const store = createBatchStore(db);
  const usage = createUsageStore(db);
  const executions = batchExecutions(client);
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tick = async () => {
    let exporting: GenerationBatch | undefined;
    await store.reconcile(async (state) => {
      await advanceBatch(state, executions);
      if (state.phase === "exporting") exporting = structuredClone(state);
    });
    // No DB transaction is held while rendering/downloading bundles. Immutable export writes
    // can be resumed after a crash; completion is conditional on still being exporting.
    if (exporting) {
      const reference = await exportBatch(exporting, artifacts, records, usage);
      await store.completeExport(exporting.run.runId, reference);
    }
  };
  const poll = () => {
    if (stopped || pending) return;
    pending = tick()
      .catch(() => {
        // Credentials/upstream outages must not drop a durable dispatch plan. Retry on next tick.
        console.error("Batch reconciliation failed; persisted batch will be retried");
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(poll, 5_000);
  timer.unref();
  poll();
  return {
    async start(run: RunRequest, token: string) {
      if (await store.read(run.runId))
        throw new Error(
          "Batch ID already exists; inspect it rather than starting another execution",
        );
      const state = await prepareGenerationBatch({ run, token, artifacts, taskQueue });
      await store.create(state);
      poll();
    },
    list: () => store.list(),
    async status(runId: string) {
      const batch = await store.read(runId);
      let base = batch
        ? await overlayCandidateActivity(client, batchStatus(batch))
        : await liveBatchStatus(client, runId);
      if (batch?.run.generation) {
        const { settings } = batch.run.generation;
        const orgId = batch.run.generation.orgId ?? batch.run.generation.ownerId;
        const provider = batch.run.version.executionBackend;
        const live = [
          ...batch.shards.map((item) => (!item.result ? item.cost : undefined)),
          ...batch.candidates.map((item) =>
            !item.result
              ? (base.activity?.[item.candidate.candidateId]?.cost ?? item.cost)
              : undefined,
          ),
        ].filter((cost) => cost !== undefined);
        const [total, ...shards] = await Promise.all([
          usage.summary(runId, orgId),
          ...batch.shards.map((shard) =>
            usage.summary(runId, orgId, {
              stage: `discover-${shard.input.wave}-${shard.input.shardIndex}`,
            }),
          ),
        ]);
        base = {
          ...base,
          cost: generationCost(total, provider, settings.authorModel, live),
          ...(base.discovery
            ? {
                discovery: {
                  ...base.discovery,
                  ...(base.discovery.shards
                    ? {
                        shards: base.discovery.shards.map((shard, index) => ({
                          ...shard,
                          cost: generationCost(
                            shards[index] ?? total,
                            provider,
                            settings.authorModel,
                            batch.shards[index]?.cost,
                          ),
                        })),
                      }
                    : {}),
                },
              }
            : {}),
        };
      }
      const listed = await loadDiscoveryShards(artifacts, runId);
      if (!listed.length && !base.discovery?.shards?.length) return base;
      return {
        ...base,
        discovery: {
          wave: base.discovery?.wave ?? 0,
          totalShards: base.discovery?.totalShards ?? listed.length,
          completedShards: base.discovery?.completedShards ?? 0,
          failedShards: base.discovery?.failedShards ?? 0,
          candidates: base.discovery?.candidates ?? base.discovered ?? 0,
          shards: mergeDiscoveryShards(base.discovery?.shards, listed),
        },
      };
    },
    async cancel(runId: string) {
      if (!(await store.cancel(runId))) await client.workflow.getHandle(runId).cancel();
      else poll();
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}
