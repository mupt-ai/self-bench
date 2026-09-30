import type { ArtifactStore } from "../../artifacts/index.js";
import type {
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  DiscoveryResult,
} from "../../contracts/index.js";
import type { BatchStore } from "../../db/batches.js";
import type { UsageLedger } from "../../db/usage.js";
import type { Vault } from "../../db/vault.js";
import { githubToken } from "../../third_party/github/token.js";
import { readGenerationGitHubToken } from "../settings/credentials.js";
import { exportBatch as buildBatchExport } from "./export.js";
import { prepareGenerationBatch } from "./prepare.js";
import {
  beginExport,
  completeExport,
  fail,
  finishCancel,
  type Outcome,
  planCandidates,
  plannedCandidates,
  recordCandidate,
  recordShard,
  recordShards,
} from "./record.js";
import type { GenerationBatch } from "./types.js";

type Shard = Pick<GenerationBatch["shards"][number], "workflowId" | "input">;

/** The batch workflow's steps; each reads and writes the batch record. */
export interface BatchActivities {
  /** Fetches merged PRs and stages the discovery shards; none when the batch already ended. */
  prepareBatch(runId: string): Promise<Shard[]>;
  recordBatchShard(runId: string, index: number, outcome: Outcome<DiscoveryResult>): Promise<void>;
  /** Plans one author workflow per discovered candidate; none when the batch ended instead. */
  planBatch(runId: string): Promise<{ workflowId: string; input: CandidateWorkflowInput }[]>;
  recordBatchCandidate(
    runId: string,
    index: number,
    outcome: Outcome<CandidateWorkflowResult>,
  ): Promise<void>;
  exportBatch(runId: string): Promise<void>;
  recordBatchCancelled(runId: string): Promise<void>;
  failBatch(runId: string, error: string): Promise<void>;
}

export function createBatchActivities(options: {
  store: BatchStore;
  artifacts: ArtifactStore;
  vault?: Vault;
  usage?: UsageLedger;
}): BatchActivities {
  const { store, artifacts, vault, usage } = options;
  const read = async (runId: string) => {
    const batch = await store.read(runId);
    if (!batch) throw new Error(`batch ${runId} not found`);
    return batch;
  };
  return {
    async prepareBatch(runId) {
      let batch = await read(runId);
      if (batch.phase === "preparing") {
        // The submitter's token, which the API saved; a local worker may use its own login.
        const token =
          (vault && (await readGenerationGitHubToken(vault.records, runId))) ||
          (await githubToken());
        if (!token) throw new Error("No GitHub token is available to read merged PRs.");
        const shards = await prepareGenerationBatch({
          run: batch.run,
          token,
          artifacts,
          attempt: Date.now(),
        });
        batch = await store.update(runId, (state) => recordShards(state, shards));
      } else if (batch.phase === "cancelling") batch = await store.update(runId, finishCancel);
      return batch.phase === "discovering"
        ? batch.shards.map(({ workflowId, input }) => ({ workflowId, input }))
        : [];
    },
    async recordBatchShard(runId, index, outcome) {
      await store.update(runId, (state) => recordShard(state, index, outcome));
    },
    async planBatch(runId) {
      return plannedCandidates(await store.update(runId, planCandidates));
    },
    async recordBatchCandidate(runId, index, outcome) {
      await store.update(runId, (state) => recordCandidate(state, index, outcome));
    },
    async exportBatch(runId) {
      const batch = await store.update(runId, beginExport);
      if (batch.phase !== "exporting") return;
      const reference = await buildBatchExport(batch, artifacts, vault, usage);
      await store.update(runId, (state) => completeExport(state, reference));
    },
    async recordBatchCancelled(runId) {
      await store.update(runId, finishCancel);
    },
    async failBatch(runId, error) {
      await store.update(runId, (state) => fail(state, error));
    },
  };
}
