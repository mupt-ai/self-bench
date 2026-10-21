import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { SelfBenchConfig } from "../../contracts/config/index.js";
import type { Candidate, CandidateWorkflowInput, TaskRevision } from "../../contracts/index.js";
import type { PullRequestCandidate } from "../../third_party/github/pr-candidate.js";
import type { ProvenanceMessage } from "../../third_party/github/provenance.js";
import { buildRunRequest, configureGenerationRun } from "../settings/run.js";
import type { GenerationReference } from "../settings/settings.js";

/** Starts one candidate workflow; the Temporal client in production, a recorder in tests. */
export type WorkflowStarter = (workflowId: string, input: CandidateWorkflowInput) => Promise<void>;

export interface TaskStartOptions {
  readonly config: SelfBenchConfig;
  readonly artifacts: ArtifactStore;
  readonly start: WorkflowStarter;
  readonly repository: { readonly fullName: string; readonly defaultBranch: string };
  readonly pullRequest: PullRequestCandidate;
  readonly attempt: number;
  readonly runId?: string;
  readonly generation?: GenerationReference;
  /** Revises an existing task's draft with a person's feedback instead of authoring afresh. */
  readonly revision?: TaskRevision;
}

export interface StartedTask {
  readonly runId: string;
  readonly workflowId: string;
  readonly candidate: Candidate;
}

/** Site-started tasks get a run of their own, so the artifact layout matches batch runs. */
export function taskRunId(fullName: string, pr: number, attempt: number): string {
  const slug = fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `pr-${slug}-${pr}${attempt > 1 ? `-a${attempt}` : ""}`;
}

/** A revision has its own run: provenance, credentials, and artifacts are run-scoped. */
export function taskRevisionRunId(fullName: string, pr: number): string {
  return `${taskRunId(fullName, pr, 1).slice(0, 40)}-r${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/**
 * Stages the PR's provenance where the pipeline expects it, builds the run request the
 * candidate activities read, and starts the candidate workflow directly, not as a child.
 */
export async function startTaskFromPullRequest(options: TaskStartOptions): Promise<StartedTask> {
  const { config, artifacts, pullRequest, repository } = options;
  const runId =
    options.runId ??
    taskRunId(repository.fullName, pullRequest.candidate.sourcePr, options.attempt);
  const runProvenance = await artifacts.put(
    `runs/${runId}/input/provenance.jsonl`,
    Buffer.from(`${JSON.stringify(pullRequest.message)}\n`),
    "application/x-ndjson",
  );
  const candidateProvenance = await artifacts.put(
    `runs/${runId}/provenance/${pullRequest.candidate.candidateId}.json`,
    Buffer.from(`${JSON.stringify(stagedProvenance(pullRequest.message))}\n`),
    "application/json",
  );
  const run = buildRunRequest(config, {
    runId,
    repository: {
      url: `https://github.com/${repository.fullName}`,
      commit: pullRequest.candidate.completedCommit,
    },
    provenance: runProvenance,
    candidateCounts: {
      easy: pullRequest.candidate.difficulty === "easy" ? 1 : 0,
      medium: pullRequest.candidate.difficulty === "medium" ? 1 : 0,
      hard: pullRequest.candidate.difficulty === "hard" ? 1 : 0,
    },
    selfbenchCommit: buildCommit,
  });
  if (options.generation) configureGenerationRun(run, options.generation, config);
  const candidate: Candidate = { ...pullRequest.candidate, provenance: candidateProvenance };
  const workflowId = `${runId}/candidate/${candidate.candidateId}`;
  await options.start(workflowId, {
    run,
    candidate,
    ...(options.revision ? { revision: options.revision } : {}),
  });
  return { runId, workflowId, candidate };
}

/** The shape discovery writes per candidate: the human request as the first user turn. */
function stagedProvenance(message: ProvenanceMessage): Record<string, unknown> {
  return { source: message, messages: [{ role: "user", content: message.content }] };
}
