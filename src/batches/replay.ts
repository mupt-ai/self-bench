import type { ArtifactStore } from "../artifacts.js";
import { commitSchema, type ReplayRunRequest, type RunRequest } from "../contracts.js";
import { apiHeaders } from "../github/oauth.js";
import { rebuildReplayCandidates } from "../temporal/activities/replay.js";
import type { GenerationBatch } from "./types.js";

/** Replay metadata is ordinary API work too, never another orchestration workflow. */
export async function prepareReplayBatch(
  input: ReplayRunRequest,
  token: string,
  artifacts: ArtifactStore,
  taskQueue: string,
): Promise<GenerationBatch> {
  async function get(path: string) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`GitHub replay metadata failed (${response.status})`);
    return response.json();
  }
  const material = await rebuildReplayCandidates(artifacts, input, {
    resolveCompletedCommit: async (repository, pr) => {
      const body = await get(`/repos/${repository}/pulls/${pr}`);
      if (!body.merged || !body.merge_commit_sha) throw new Error("Replay PR is not merged");
      return commitSchema.parse(body.merge_commit_sha);
    },
    resolveRepositoryHead: async (repository) => {
      const body = await get(`/repos/${repository}/commits/HEAD`);
      return commitSchema.parse(body.sha);
    },
  });
  const run: RunRequest = {
    runId: input.runId,
    repository: material.repository,
    provenance: material.provenance,
    authoring: input.authoring,
    version: input.version,
    candidateCounts: { easy: 0, medium: 0, hard: 0 },
  };
  for (const candidate of material.candidates) run.candidateCounts[candidate.difficulty]++;
  return {
    run,
    taskQueue,
    phase: "authoring",
    shards: [],
    candidates: material.candidates.map((candidate) => ({
      workflowId: `${run.runId}/candidate/${candidate.candidateId}`,
      candidate,
    })),
  };
}
