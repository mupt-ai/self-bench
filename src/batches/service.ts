import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../artifacts.js";
import { isReplayRunRequest, type WorkflowRunInput } from "../contracts.js";
import type { Database } from "../db/client.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import { createUsageStore } from "../managed/usage-store.js";
import { liveBatchStatus } from "../site/batch-activity.js";
import { loadDiscoveryShards, mergeDiscoveryShards } from "../viewer/discovery.js";
import { advanceBatch } from "./advance.js";
import { exportBatch } from "./export.js";
import { prepareGenerationBatch } from "./prepare.js";
import { prepareReplayBatch } from "./replay.js";
import { batchStatus } from "./status.js";
import { createBatchStore } from "./store.js";
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
    async start(run: WorkflowRunInput, token: string) {
      if (await store.read(run.runId))
        throw new Error(
          "Batch ID already exists; inspect it rather than starting another execution",
        );
      const state = isReplayRunRequest(run)
        ? await prepareReplayBatch(run, token, artifacts, taskQueue)
        : await prepareGenerationBatch({ run, token, artifacts, taskQueue });
      await store.create(state);
      poll();
    },
    list: () => store.list(),
    async status(runId: string) {
      const batch = await store.read(runId);
      const status = batch ? batchStatus(batch) : await liveBatchStatus(client, runId);
      const listed = await loadDiscoveryShards(artifacts, runId);
      if (!listed.length && !status.discovery?.shards?.length) return status;
      return {
        ...status,
        discovery: {
          wave: status.discovery?.wave ?? 0,
          totalShards: status.discovery?.totalShards ?? listed.length,
          completedShards: status.discovery?.completedShards ?? 0,
          failedShards: status.discovery?.failedShards ?? 0,
          candidates: status.discovery?.candidates ?? status.discovered ?? 0,
          shards: mergeDiscoveryShards(status.discovery?.shards, listed),
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
