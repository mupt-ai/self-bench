import type { ArtifactStore } from "../artifacts.js";
import type { RunRequest } from "../contracts.js";
import { combineRunProvenance } from "../provenance.js";
import { collectExcludedSourcePrs } from "../temporal/activities/excluded-source-prs.js";
import { parseProvenance } from "../temporal/activities/runtime.js";
import { fetchBatchPullRequests } from "./github.js";
import { partitionPullRequests, takeNewestShards } from "./shards.js";
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
  const local = parseProvenance(await artifacts.get(run.provenance));
  const messages = combineRunProvenance(run.repository.url, local, github);
  const excludedSourcePrs = run.excludeRuns?.length
    ? await collectExcludedSourcePrs(artifacts, run.excludeRuns)
    : [];
  const chunks = partitionPullRequests(
    messages.filter(
      (message) => message.sourcePr !== undefined && !excludedSourcePrs.includes(message.sourcePr),
    ),
  );
  if (!chunks.length) throw new Error("No eligible merged PRs found");
  // One discovery agent can fill a small request from a single 25-PR window. Do not
  // start a shard per remaining PR group when the batch only asked for a few tasks.
  const needed = Math.max(1, Math.max(...Object.values(run.candidateCounts)));
  const selected = takeNewestShards(chunks, needed);
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
        excludedSourcePrs,
      },
    });
  }
  return { run, taskQueue: options.taskQueue, phase: "discovering", shards, candidates: [] };
}
