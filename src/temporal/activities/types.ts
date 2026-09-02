import type {
  ArtifactRef,
  AuthoredTask,
  AuthoredTaskDraft,
  AuthoringRoundResult,
  Candidate,
  Difficulty,
  DiscoveryResult,
  ReplayMaterial,
  ReplayRunRequest,
  RunRequest,
  VerifierRoundResult,
  VerifyOutcome,
  VerifyStage,
} from "../../contracts.js";

export interface DiscoveryShardInput {
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
  /** In-session verify calls already spent in earlier rounds of this session. */
  readonly verifyCallsUsed?: number;
}

/** Trusted compile + audit + Harbor build/smoke/nop/oracle for one submission. */
export interface CompileAndVerifyInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly task: AuthoredTaskDraft;
  readonly stage: VerifyStage;
  readonly round: number;
}

/** One verification agent turn over a green task and its latest report. */
export interface VerifierRoundInput {
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
  discoverCandidateShard(input: DiscoveryShardInput): Promise<DiscoveryResult>;
  rebuildReplayCandidates(input: ReplayRunRequest): Promise<ReplayMaterial>;
  runAuthoringRound(input: AuthoringRoundInput): Promise<AuthoringRoundResult>;
  compileAndVerify(input: CompileAndVerifyInput): Promise<VerifyOutcome>;
  runVerifierRound(input: VerifierRoundInput): Promise<VerifierRoundResult>;
  buildExport(input: ExportInput): Promise<ArtifactRef>;
}
