import type { ArtifactStore } from "../../artifacts/index.js";
import { MAX_DISCOVERY_SHARDS } from "../../contracts/config/execution-limits.js";
import type { RunRequest } from "../../contracts/index.js";
import {
  DEFAULT_PR_FETCH_LIMIT,
  fetchBatchPullRequests,
  MAX_PR_FETCH_LIMIT,
} from "../../third_party/github/batch-pull-requests.js";
import {
  discoveryPrsPerShard,
  FOCUSED_PRS_PER_SHARD,
  FOCUSED_SHARD_SURPLUS,
  MAX_FOCUSED_DISCOVERY_SHARDS,
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
  // One discovery agent can fill a small request from a single PR window. Larger
  // requests widen each window rather than exceeding the workflow shard bound.
  const requested = Object.values(run.candidateCounts).reduce((total, count) => total + count, 0);
  const needed = Math.max(1, Math.max(...Object.values(run.candidateCounts)));
  // A focused window can't widen, so a focused batch looks further back with more shards.
  const shardCount = Math.min(
    run.focus ? MAX_FOCUSED_DISCOVERY_SHARDS : MAX_DISCOVERY_SHARDS,
    needed,
  );
  const github = await fetchBatchPullRequests({
    repositoryUrl: run.repository.url,
    token: options.token,
    // Twice the focused windows, since drafts, bots, and tiny PRs drop out after the fetch.
    ...(run.focus
      ? {
          limit: Math.min(
            MAX_PR_FETCH_LIMIT,
            Math.max(DEFAULT_PR_FETCH_LIMIT, 2 * shardCount * FOCUSED_PRS_PER_SHARD),
          ),
        }
      : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const chunks = partitionPullRequests(github.filter((message) => message.sourcePr !== undefined));
  if (!chunks.length) throw new NoEligiblePullRequestsError();
  const prCount = new Set(chunks.flat().map((message) => message.sourcePr)).size;
  const prsPerShard = run.focus
    ? Math.max(1, Math.min(FOCUSED_PRS_PER_SHARD, Math.ceil(prCount / shardCount)))
    : discoveryPrsPerShard(requested, shardCount);
  const selected = takeNewestShards(chunks, shardCount, prsPerShard);
  // A focus's matches cluster in a few windows, so a focused shard may propose a few times its
  // share of each tier, and planning trims each tier to its count.
  const targetCountsForShard = (shardIndex: number): RunRequest["candidateCounts"] =>
    Object.fromEntries(
      Object.entries(run.candidateCounts).map(([tier, count]) => [
        tier,
        run.focus
          ? Math.min(count, FOCUSED_SHARD_SURPLUS * Math.ceil(count / selected.length))
          : Math.floor(count / selected.length) + (shardIndex < count % selected.length ? 1 : 0),
      ]),
    ) as RunRequest["candidateCounts"];
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
          targetCounts: targetCountsForShard(index),
          excludedSourcePrs: [],
        },
      };
    }),
  );
}
