import type {
  ArtifactRef,
  AuditResult,
  AuthoredTask,
  AuthoredTaskDraft,
  AuthorOutcome,
  Candidate,
  Difficulty,
  DiscoveryResult,
  EnvironmentPreflightResult,
  ReviewResult,
  RunRequest,
  TaskAuthorOutcome,
  ValidationResult,
} from "../../contracts.js";

export interface AuthorCandidateInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
}

export interface DiscoveryShardInput {
  readonly run: RunRequest;
  readonly wave: number;
  readonly shardIndex: number;
  readonly shardCount: number;
  readonly targetCounts: Readonly<Record<Difficulty, number>>;
  readonly excludedSourcePrs: readonly number[];
}

export interface EnvironmentAuthoringInput {
  readonly run: RunRequest;
  readonly task: AuthoredTaskDraft;
  readonly diagnostics?: string;
  readonly previousTask?: AuthoredTask;
}

export interface TaskStageInput {
  readonly run: RunRequest;
  readonly task: AuthoredTask;
}

export interface RepairTaskInput extends TaskStageInput {
  readonly review: ArtifactRef;
}

export interface ValidationRepairTaskInput extends TaskStageInput {
  readonly validation: ValidationResult;
}

export interface ExportInput {
  readonly run: RunRequest;
  readonly tasks: readonly AuthoredTask[];
}

export interface SelfBenchActivities {
  collectRunProvenance(run: RunRequest): Promise<ArtifactRef>;
  discoverCandidateShard(input: DiscoveryShardInput): Promise<DiscoveryResult>;
  authorCandidate(input: AuthorCandidateInput): Promise<TaskAuthorOutcome>;
  authorEnvironment(input: EnvironmentAuthoringInput): Promise<AuthorOutcome>;
  preflightEnvironment(input: TaskStageInput): Promise<EnvironmentPreflightResult>;
  validateTask(input: TaskStageInput): Promise<ValidationResult>;
  repairValidationTask(input: ValidationRepairTaskInput): Promise<AuthorOutcome>;
  reviewTask(input: TaskStageInput): Promise<ReviewResult>;
  repairTask(input: RepairTaskInput): Promise<AuthorOutcome>;
  auditTask(input: TaskStageInput): Promise<AuditResult>;
  buildExport(input: ExportInput): Promise<ArtifactRef>;
}
