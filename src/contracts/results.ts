import type { ArtifactRef, Difficulty, RepositoryRef } from "./common.js";
import type { RunRequest } from "./run.js";
import type { AuthoredTask, Candidate } from "./task.js";
import type { VerifyStage } from "./verify.js";

export type RunPhase =
  | "queued"
  | "discovering"
  | "authoring"
  | "exporting"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelled";

/**
 * Per-candidate progress. `authoring` is an authoring-agent round, `verifying` the mechanical
 * compile/audit/build/smoke/nop/oracle gates, and `reviewing` a verification-agent round; `stage`
 * and `round` say which loop is running.
 */
export interface TaskProgress {
  taskId: string;
  candidateId: string;
  difficulty: Difficulty;
  status:
    | "authoring"
    | "verifying"
    | "reviewing"
    | "infrastructure_failed"
    | "rejected"
    | "accepted";
  stage?: VerifyStage;
  round?: number;
  reason?: string;
}

export interface DiscoveryProgress {
  readonly wave: number;
  readonly totalShards: number;
  readonly completedShards: number;
  readonly failedShards: number;
  readonly candidates: number;
}

export interface RunStatus {
  readonly runId: string;
  readonly phase: RunPhase;
  readonly requested: number;
  readonly requestedByDifficulty: Readonly<Record<Difficulty, number>>;
  readonly discovered: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly tasks: readonly TaskProgress[];
  readonly discovery?: DiscoveryProgress;
  readonly export?: ArtifactRef;
  readonly error?: string;
}

export interface RunResult {
  readonly runId: string;
  readonly export: ArtifactRef;
  readonly acceptedTaskIds: readonly string[];
}

/** Input of one candidate child workflow. */
export interface CandidateWorkflowInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
}

/** Authoritative outcome of one candidate child workflow; `task` is present only when accepted. */
export interface CandidateWorkflowResult {
  readonly progress: TaskProgress;
  readonly task?: AuthoredTask;
  readonly report?: ArtifactRef;
}

export interface DiscoveryResult {
  readonly candidates: readonly Candidate[];
  readonly report: ArtifactRef;
}

/** Candidates and run metadata rebuilt from a source run for a replay. */
export interface ReplayMaterial {
  readonly candidates: readonly Candidate[];
  readonly repository: RepositoryRef;
  readonly provenance: ArtifactRef;
}
