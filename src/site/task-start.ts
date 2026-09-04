import { buildRunRequest } from "../api/run-request.js";
import type { ArtifactStore } from "../artifacts.js";
import { buildCommit } from "../build-metadata.js";
import type { SelfBenchConfig } from "../config.js";
import type { Candidate, CandidateWorkflowInput } from "../contracts.js";
import type { ProvenanceMessage } from "../provenance/types.js";
import type { PullRequestCandidate } from "./pr-candidate.js";

/** Starts one candidate workflow; the Temporal client in production, a recorder in tests. */
export type WorkflowStarter = (workflowId: string, input: CandidateWorkflowInput) => Promise<void>;

export interface TaskStartOptions {
  readonly config: SelfBenchConfig;
  readonly artifacts: ArtifactStore;
  readonly start: WorkflowStarter;
  readonly repository: { readonly fullName: string; readonly defaultBranch: string };
  readonly pullRequest: PullRequestCandidate;
  readonly attempt: number;
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

/**
 * Stages the PR's provenance where the pipeline expects it, builds the run request the
 * candidate activities read, and starts the candidate workflow directly, not as a child.
 */
export async function startTaskFromPullRequest(options: TaskStartOptions): Promise<StartedTask> {
  const { config, artifacts, pullRequest, repository } = options;
  const runId = taskRunId(repository.fullName, pullRequest.candidate.sourcePr, options.attempt);
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
  if ("replay" in run) throw new Error("unexpected replay request");
  const candidate: Candidate = { ...pullRequest.candidate, provenance: candidateProvenance };
  const workflowId = `${runId}/candidate/${candidate.candidateId}`;
  await options.start(workflowId, { run, candidate });
  return { runId, workflowId, candidate };
}

/** The shape discovery writes per candidate: the human request as the first user turn. */
function stagedProvenance(message: ProvenanceMessage): Record<string, unknown> {
  return { source: message, messages: [{ role: "user", content: message.content }] };
}
