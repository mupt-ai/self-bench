import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { RunRequest } from "../../contracts/index.js";
import { createBatchStore } from "../../db/batches.js";
import type { Database } from "../../db/client.js";
import { createUsageStore } from "../../db/usage.js";
import type { Vault } from "../../db/vault.js";
import { settleWithLimit } from "../../lib/util.js";
import { generationCost } from "../billing/cost-status.js";
import { loadDiscoveryShards, mergeDiscoveryShards } from "../runs/discovery-shards.js";
import { overlayCandidateActivity } from "./activity.js";
import { advanceBatch, planBatchDispatch } from "./advance.js";
import { exportBatch } from "./export.js";
import { prepareGenerationBatch } from "./prepare.js";
import { batchStatus } from "./status.js";
import { batchExecutions } from "./temporal.js";
import type { GenerationBatch } from "./types.js";

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

/** Batches reconciled at once; each holds one pooled DB connection while its RPCs run. */
const BATCH_CONCURRENCY = 4;

/** A restartable application reconciler, not a Temporal orchestration workflow. */
export function createGenerationBatches(
  db: Database,
  client: Client,
  artifacts: ArtifactStore,
  taskQueue: string,
  vault?: Vault,
) {
  const store = createBatchStore(db);
  const usage = createUsageStore(db);
  const executions = batchExecutions(client);
  let stopped = false;
  let pending: Promise<void> | undefined;
  const exports = new Map<string, Promise<void>>();
  // No DB transaction is held while rendering/downloading bundles, and a slow export never
  // stalls other batches. Immutable export writes can be resumed after a crash; completion is
  // conditional on still being exporting.
  const startExport = (batch: GenerationBatch) => {
    const runId = batch.run.runId;
    if (exports.has(runId)) return;
    exports.set(
      runId,
      exportBatch(batch, artifacts, vault, usage)
        .then((reference) => store.completeExport(runId, reference))
        .catch(() => console.error(`Batch ${runId} export failed; it will be retried`))
        .finally(() => exports.delete(runId)),
    );
  };
  const reconcile = async (runId: string) => {
    // The dispatch plan commits before any start, so a crash leaves every start owned.
    await store.reconcile(runId, async (state) => planBatchDispatch(state));
    let exporting: GenerationBatch | undefined;
    await store.reconcile(runId, async (state) => {
      await advanceBatch(state, executions);
      if (state.phase === "exporting") exporting = structuredClone(state);
    });
    if (exporting) startExport(exporting);
  };
  const tick = async () => {
    const runIds = await store.activeRunIds();
    const results = await settleWithLimit(runIds, BATCH_CONCURRENCY, reconcile);
    // Credentials/upstream outages must not drop a durable dispatch plan. Retry on next tick.
    results.forEach((result, index) => {
      if (result.status === "rejected")
        console.error(`Batch ${runIds[index]} reconciliation failed; it will be retried`);
    });
  };
  const poll = () => {
    if (stopped || pending) return;
    pending = tick()
      .catch(() => {
        console.error("Batch reconciliation failed; persisted batches will be retried");
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
    read: (runId: string) => store.read(runId),
    async status(runId: string) {
      const batch = await store.read(runId);
      if (!batch) throw new RunNotFoundError(runId);
      let base = await overlayCandidateActivity(client, batchStatus(batch));
      if (batch.run.generation) {
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
      await Promise.all(exports.values());
    },
  };
}
