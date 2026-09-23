import type { ArtifactStore } from "../../artifacts/index.js";
import { MAX_DISCOVERY_SHARDS } from "../../contracts/config/execution-limits.js";
import type { RunRequest } from "../../contracts/index.js";
import { fetchBatchPullRequests } from "../../third_party/github/batch-pull-requests.js";
import { discoveryPrsPerShard, partitionPullRequests, takeNewestShards } from "./shards.js";
import type { GenerationBatch } from "./types.js";

/** All ordinary GitHub I/O finishes here, before any Temporal execution is started. */
export async function prepareGenerationBatch(options: {
  run: RunRequest;
  token: string;
  artifacts: ArtifactStore;
  taskQueue: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  endpoint?: string;
}): Promise<GenerationBatch> {
  const { run, artifacts } = options;
  const github = await fetchBatchPullRequests({
    repositoryUrl: run.repository.url,
    token: options.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
  const chunks = partitionPullRequests(github.filter((message) => message.sourcePr !== undefined));
  if (!chunks.length) throw new Error("No eligible merged PRs found");
  // One discovery agent can fill a small request from a single PR window. Larger
  // requests widen each window rather than exceeding the workflow shard bound.
  const requested = Object.values(run.candidateCounts).reduce((total, count) => total + count, 0);
  const needed = Math.max(1, Math.max(...Object.values(run.candidateCounts)));
  const shardCount = Math.min(MAX_DISCOVERY_SHARDS, needed);
  const selected = takeNewestShards(
    chunks,
    shardCount,
    discoveryPrsPerShard(requested, shardCount),
  );
  const shards: GenerationBatch["shards"] = [];
  for (const [index, chunk] of selected.entries()) {
    const provenance = await artifacts.put(
      `runs/${run.runId}/input/shard-${index}.jsonl`,
      Buffer.from(`${chunk.map((message) => JSON.stringify(message)).join("\n")}\n`),
      "application/x-ndjson",
    );
    shards.push({
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
    });
  }
  return { run, taskQueue: options.taskQueue, phase: "discovering", shards, candidates: [] };
}
