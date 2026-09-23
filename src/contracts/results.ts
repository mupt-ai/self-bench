import type { ArtifactRef, Difficulty } from "./common.js";
import type { RunRequest } from "./run.js";
import type { AuthoredTask, Candidate } from "./task.js";
import type { PipelineStage } from "./verify.js";

export type RunPhase =
  | "queued"
  | "discovering"
  | "authoring"
  | "exporting"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelling"
  | "cancelled";

/**
 * Per-candidate progress. `authoring` is an authoring-agent round, `verifying` the mechanical
 * compile/audit/build/smoke/nop/oracle gates, and `reviewing` an independent review round; `stage`
 * and `round` say which loop is running.
 */
type CostState = "estimated" | "partial" | "unpriced" | "unknown";

/** Current generation spend. Missing USD fields are deliberate, never zero-filled estimates. */
export interface GenerationCost {
  readonly state: CostState;
  readonly usd?: number;
  readonly sandboxUsd?: number;
  readonly modelUsd?: number;
  readonly sandboxSeconds: number;
  readonly updatedAt: string;
}

export interface TaskProgress {
  taskId: string;
  candidateId: string;
  difficulty: Difficulty;
  status:
    | "queued"
    | "authoring"
    | "verifying"
    | "reviewing"
    | "infrastructure_failed"
    | "rejected"
    | "accepted";
  stage?: PipelineStage;
  round?: number;
  reason?: string;
}

export interface DiscoveryShardProgress {
  readonly wave: number;
  readonly shardIndex: number;
  readonly cost?: GenerationCost;
  readonly attempt?: number;
  readonly liveKey?: string;
  readonly logKey?: string;
  readonly error?: string;
}

interface DiscoveryProgress {
  readonly wave: number;
  readonly totalShards: number;
  readonly completedShards: number;
  readonly failedShards: number;
  readonly candidates: number;
  readonly shards?: readonly DiscoveryShardProgress[];
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
  readonly cost?: GenerationCost;
  readonly discovery?: DiscoveryProgress;
  readonly export?: ArtifactRef;
  readonly error?: string;
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
