import type {
  ArtifactRef,
  AuthoredTask,
  AuthoredTaskDraft,
  AuthoringRoundResult,
  Candidate,
  Difficulty,
  DiscoveryResult,
  PipelineStage,
  ReplayMaterial,
  ReplayRunRequest,
  ReviewRoundResult,
  RunRequest,
  VerifyOutcome,
} from "../../contracts.js";

export interface DiscoveryShardInput {
  /** The application already grouped this immutable PR chunk. No worker-side repartitioning. */
  readonly partitioned?: boolean;
  readonly run: RunRequest;
  readonly wave: number;
  readonly shardIndex: number;
  readonly shardCount: number;
  readonly targetCounts: Readonly<Record<Difficulty, number>>;
  readonly excludedSourcePrs: readonly number[];
}

/** One authoring agent turn: a fresh session on round 1, a resumed session afterwards. */
export interface AuthoringRoundInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly round: number;
  /** Previous round's pi session file; required for round > 1. */
  readonly session?: ArtifactRef;
  /** Previous round's stored VerifyReport JSON; required for round > 1. */
  readonly report?: ArtifactRef;
  /** Read-only verifier suggestions for the next authoring round. */
  readonly feedback?: string;
}

/** Trusted compile + audit + Harbor build/smoke/nop/oracle for one submission. */
export interface CompileAndVerifyInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly task: AuthoredTaskDraft;
  readonly stage: PipelineStage;
  readonly round: number;
}

/** One independent review turn over a green task and its latest mechanical report. */
export interface ReviewRoundInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly task: AuthoredTask;
  readonly report: ArtifactRef;
  readonly round: number;
  readonly session?: ArtifactRef;
  readonly verifyCallsUsed?: number;
}

export interface ExportInput {
  readonly run: RunRequest;
  readonly tasks: readonly AuthoredTask[];
}

export interface SelfBenchActivities {
  collectRunProvenance(run: RunRequest): Promise<ArtifactRef>;
  /** Source PRs processed by the listed earlier runs, for cross-run discovery exclusion. */
  collectExcludedSourcePrs(runIds: readonly string[]): Promise<number[]>;
  discoverCandidateShard(input: DiscoveryShardInput): Promise<DiscoveryResult>;
  rebuildReplayCandidates(input: ReplayRunRequest): Promise<ReplayMaterial>;
  runAuthoringRound(input: AuthoringRoundInput): Promise<AuthoringRoundResult>;
  compileAndVerify(input: CompileAndVerifyInput): Promise<VerifyOutcome>;
  runReviewRound(input: ReviewRoundInput): Promise<ReviewRoundResult>;
  /** @deprecated Kept for Temporal histories created before the review terminology rename. */
  runVerifierRound(input: ReviewRoundInput): Promise<ReviewRoundResult>;
  buildExport(input: ExportInput): Promise<ArtifactRef>;
}
