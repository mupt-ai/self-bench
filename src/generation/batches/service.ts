import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { WorkflowIdReusePolicy } from "@temporalio/common";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { RunRequest } from "../../contracts/index.js";
import { createBatchStore } from "../../db/batches.js";
import type { Database } from "../../db/client.js";
import { createUsageStore } from "../../db/usage.js";
import { generationCost } from "../billing/cost-status.js";
import { loadDiscoveryShards, mergeDiscoveryShards } from "../runs/discovery-shards.js";
import type { BatchStatus } from "./progress.js";
import { abandon } from "./record.js";
import { batchStatus } from "./status.js";
import { batchObserver, batchWorkflowStatus } from "./temporal.js";
import { type GenerationBatch, isFinished } from "./types.js";
import { selfBenchBatchWorkflow } from "./workflow.js";

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

/** A batch whose workflow is still missing this long after it was accepted never started. */
const START_GRACE_MS = 5 * 60_000;

/** Starts, reads and cancels batches; each batch runs as its own selfBenchBatchWorkflow. */
export function createGenerationBatches(
  db: Database,
  client: Client,
  artifacts: ArtifactStore,
  taskQueue: string,
) {
  const store = createBatchStore(db);
  const usage = createUsageStore(db);
  const observe = batchObserver(client);
  // A workflow that closed, or never started, without recording an outcome leaves its batch
  // unfinished; the next read settles it.
  const settleAbandoned = async (batch: GenerationBatch) => {
    if (isFinished(batch.phase)) return batch;
    const status = await batchWorkflowStatus(client, batch.run.runId).catch(() => "RUNNING");
    if (status === "RUNNING") return batch;
    if (!status && Date.now() - (batch.acceptedAt ?? 0) < START_GRACE_MS) return batch;
    return store.update(batch.run.runId, (state) => abandon(state, status));
  };
  return {
    async start(run: RunRequest) {
      if (await store.read(run.runId))
        throw new Error(
          "Batch ID already exists; inspect it rather than starting another execution",
        );
      await store.create({
        run,
        taskQueue,
        phase: "preparing",
        acceptedAt: Date.now(),
        shards: [],
        candidates: [],
      });
      try {
        await client.workflow.start(selfBenchBatchWorkflow, {
          workflowId: run.runId,
          taskQueue,
          args: [run.runId],
          workflowExecutionTimeout: "15 days",
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    },
    list: () => store.list(),
    read: (runId: string) => store.read(runId),
    async status(runId: string): Promise<BatchStatus> {
      const stored = await store.read(runId);
      if (!stored) throw new RunNotFoundError(runId);
      const { batch, activity } = await observe(await settleAbandoned(stored));
      let base: BatchStatus = { ...batchStatus(batch), ...(activity ? { activity } : {}) };
      if (batch.run.generation) {
        const { settings } = batch.run.generation;
        const orgId = batch.run.generation.orgId ?? batch.run.generation.ownerId;
        const provider = batch.run.version.executionBackend;
        const live = [...batch.shards, ...batch.candidates]
          .map((item) => (!item.result ? item.cost : undefined))
          .filter((cost) => cost !== undefined);
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
    /** Shows the cancel at once, then cancels the workflow, which records where it stopped. */
    async cancel(runId: string) {
      await store.cancel(runId);
      try {
        await client.workflow.getHandle(runId).cancel();
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
      }
    },
  };
}
