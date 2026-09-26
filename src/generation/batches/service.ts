import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../../artifacts/index.js";
import { BATCH_SWEEP_CONCURRENCY } from "../../contracts/config/execution-limits.js";
import type { RunRequest } from "../../contracts/index.js";
import { createBatchStore } from "../../db/batches.js";
import type { Database } from "../../db/client.js";
import { createUsageStore } from "../../db/usage.js";
import type { Vault } from "../../db/vault.js";
import { errorMessage, settleWithLimit } from "../../lib/util.js";
import { generationCost } from "../billing/cost-status.js";
import { loadDiscoveryShards, mergeDiscoveryShards } from "../runs/discovery-shards.js";
import { readGenerationGitHubToken } from "../settings/credentials.js";
import { overlayCandidateActivity } from "./activity.js";
import { advanceBatch } from "./advance.js";
import { planDispatch, workflowLimit } from "./dispatch.js";
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

type PrepareOutcome = Pick<GenerationBatch, "shards"> | { error: string };

/** A preparation claim older than this belongs to a crashed replica and may be retaken. */
const PREPARE_STALE_MS = 10 * 60_000;

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
  // Cancels this replica is waiting to record; their batches' sweeps stop starting work.
  const cancelling = new Set<string>();
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
  // Submitters' GitHub tokens for batches this replica accepted; hosted generation also saves
  // the token in the vault, so any replica can take over its preparation.
  const tokens = new Map<string, string>();
  const preparing = new Map<string, Promise<void>>();
  // Outcomes whose recording failed; this replica still holds their claim, so it retries the
  // write rather than waiting for the claim to go stale.
  const unrecorded = new Map<string, { attempt: number; outcome: PrepareOutcome }>();
  const record = async (runId: string, attempt: number, outcome: PrepareOutcome) => {
    unrecorded.set(runId, { attempt, outcome });
    await store.completePrepare(runId, attempt, outcome);
    unrecorded.delete(runId);
    tokens.delete(runId);
    poll();
  };
  const prepare = async (runId: string) => {
    const pending = unrecorded.get(runId);
    if (pending) return record(runId, pending.attempt, pending.outcome);
    const token =
      tokens.get(runId) ??
      (vault ? await readGenerationGitHubToken(vault.records, runId) : undefined);
    const staleBefore = Date.now() - PREPARE_STALE_MS;
    if (!token) {
      await store.abandonPrepare(
        runId,
        staleBefore,
        "Batch preparation was interrupted. Start another batch.",
      );
      return;
    }
    const claimed = await store.claimPrepare(runId, Date.now(), staleBefore);
    if (!claimed) return;
    let outcome: PrepareOutcome;
    try {
      const { shards } = await prepareGenerationBatch({
        run: claimed.run,
        token,
        artifacts,
        taskQueue: claimed.taskQueue,
        attempt: claimed.prepareAttempt,
      });
      outcome = { shards };
    } catch (error) {
      outcome = { error: errorMessage(error) };
    }
    await record(runId, claimed.prepareAttempt, outcome);
  };
  // Like exports, GitHub I/O runs outside any row lock and never stalls other batches.
  const startPrepare = (runId: string) => {
    if (preparing.has(runId)) return;
    preparing.set(
      runId,
      prepare(runId)
        .catch(() => console.error(`Batch ${runId} preparation failed; it will be retried`))
        .finally(() => preparing.delete(runId)),
    );
  };
  const limit = workflowLimit();
  const reconcile = async (runId: string) => {
    let exporting: GenerationBatch | undefined;
    let unprepared = false;
    await store.reconcile(runId, async (state) => {
      unprepared = state.phase === "preparing";
      await advanceBatch(state, executions, Date.now(), () => cancelling.has(runId));
      if (state.phase === "exporting") exporting = structuredClone(state);
    });
    if (unprepared) startPrepare(runId);
    if (exporting) startExport(exporting);
  };
  const tick = async () => {
    // The dispatch plan commits before any start, so a crash leaves every start owned.
    await store.plan((batches) => planDispatch(batches, limit));
    const runIds = await store.activeRunIds();
    const results = await settleWithLimit(runIds, BATCH_SWEEP_CONCURRENCY, reconcile);
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
      // Only record the batch here; the sweep prepares it, so the submitter never waits on
      // the merged-PR fetch.
      tokens.set(run.runId, token);
      try {
        await store.create({
          run,
          taskQueue,
          phase: "preparing",
          acceptedAt: Date.now(),
          shards: [],
          candidates: [],
        });
      } catch (error) {
        tokens.delete(run.runId);
        throw error;
      }
      startPrepare(run.runId);
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
      cancelling.add(runId);
      try {
        if (!(await store.cancel(runId))) await client.workflow.getHandle(runId).cancel();
        else poll();
      } finally {
        cancelling.delete(runId);
      }
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await pending;
      await Promise.all([...preparing.values(), ...exports.values()]);
    },
  };
}
