import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/index.js";
import { buildCommit } from "../config/build-metadata.js";
import type { SelfBenchConfig } from "../config/index.js";
import { commitSchema, type RunRequest, runRequestSchema } from "../contracts/index.js";
import { configureGenerationRun } from "../generation/run.js";
import { buildRunRequest } from "../generation/run-request.js";
import { type GenerationReference, generationSettingsSchema } from "../generation/settings.js";
import { apiHeaders, GitHubOAuthError } from "../github/oauth.js";
import type { ConnectedRepo } from "../repos/store.js";

export const batchSubmissionSchema = z
  .object({
    candidateCounts: runRequestSchema.shape.candidateCounts,
    generation: generationSettingsSchema.optional(),
  })
  .strict();

export type BatchStarter = (input: RunRequest, githubToken: string) => Promise<void>;

/** Resolve an immutable repository revision; workers collect merged-PR provenance, not the browser. */
export async function prepareBatch(options: {
  config: SelfBenchConfig;
  artifacts: ArtifactStore;
  repo: ConnectedRepo;
  token: string;
  githubApiUrl: string;
  candidateCounts: RunRequest["candidateCounts"];
  fetchImpl?: typeof fetch;
  generation?: GenerationReference;
}): Promise<RunRequest> {
  const { repo, token, config, artifacts, candidateCounts } = options;
  const response = await (options.fetchImpl ?? fetch)(
    `${options.githubApiUrl}/repos/${repo.fullName}/commits/${encodeURIComponent(repo.defaultBranch)}`,
    { headers: apiHeaders(token), signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok)
    throw new GitHubOAuthError(
      `Cannot resolve repository revision (${response.status})`,
      response.status,
    );
  const commit = commitSchema.parse(((await response.json()) as { sha?: unknown }).sha);
  const runId = `batch-${randomUUID()}`;
  // Run requests carry a provenance artifact; a batch's is empty because prepareGenerationBatch
  // reads merged PRs straight from GitHub. OAuth secrets never enter history.
  const provenance = await artifacts.put(
    `runs/${runId}/input/provenance.jsonl`,
    Buffer.alloc(0),
    "application/x-ndjson",
  );
  const run = buildRunRequest(config, {
    runId,
    repository: { url: `https://github.com/${repo.fullName}`, commit },
    provenance,
    candidateCounts,
    selfbenchCommit: buildCommit,
  });
  if (options.generation) configureGenerationRun(run, options.generation, config);
  return run;
}
