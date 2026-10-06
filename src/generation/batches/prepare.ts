import type { ArtifactStore } from "../../artifacts/index.js";
import { MAX_DISCOVERY_SHARDS } from "../../contracts/config/execution-limits.js";
import type { RunRequest } from "../../contracts/index.js";
import { fetchBatchPullRequests } from "../../third_party/github/batch-pull-requests.js";
import {
  discoveryPrsPerShard,
  FOCUSED_PRS_PER_SHARD,
  partitionPullRequests,
  takeNewestShards,
} from "./shards.js";
import type { GenerationBatch } from "./types.js";

/** Final: retrying the fetch finds the same PRs. */
export class NoEligiblePullRequestsError extends Error {
  constructor() {
    super("No eligible merged PRs found");
    this.name = "NoEligiblePullRequestsError";
  }
}

/** The merged-PR fetch and shard staging, before any discovery workflow starts. */
export async function prepareGenerationBatch(options: {
  run: RunRequest;
  token: string;
  artifacts: ArtifactStore;
  /** Artifacts are write-once, so each attempt (epoch ms) stages its own shard inputs. */
  attempt: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<GenerationBatch["shards"]> {
  const { run, artifacts } = options;
  const github = await fetchBatchPullRequests({
    repositoryUrl: run.repository.url,
    token: options.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const chunks = partitionPullRequests(github.filter((message) => message.sourcePr !== undefined));
  if (!chunks.length) throw new NoEligiblePullRequestsError();
  // One discovery agent can fill a small request from a single PR window. Larger
  // requests widen each window rather than exceeding the workflow shard bound.
  const requested = Object.values(run.candidateCounts).reduce((total, count) => total + count, 0);
  const needed = Math.max(1, Math.max(...Object.values(run.candidateCounts)));
  const shardCount = Math.min(MAX_DISCOVERY_SHARDS, needed);
  // A focus is often rare among recent PRs, so focused discovery looks further back.
  const prsPerShard = run.focus
    ? FOCUSED_PRS_PER_SHARD
    : discoveryPrsPerShard(requested, shardCount);
  const selected = takeNewestShards(chunks, shardCount, prsPerShard);
  const input = `runs/${run.runId}/input/attempt-${options.attempt}`;
  return await Promise.all(
    selected.map(async (chunk, index) => {
      const provenance = await artifacts.put(
        `${input}/shard-${index}.jsonl`,
        Buffer.from(`${chunk.map((message) => JSON.stringify(message)).join("\n")}\n`),
        "application/x-ndjson",
      );
      return {
        workflowId: `${run.runId}/discovery/${index}`,
        input: {
          run: { ...run, provenance },
          partitioned: true,
          wave: 0,
          shardIndex: index,
          shardCount: selected.length,
          targetCounts: Object.fromEntries(
            Object.entries(run.candidateCounts).map(([tier, count]) => [
              tier,
              count === 0 ? 0 : Math.max(1, Math.ceil(count / selected.length)),
            ]),
          ) as RunRequest["candidateCounts"],
          excludedSourcePrs: [],
        },
      };
    }),
  );
}
