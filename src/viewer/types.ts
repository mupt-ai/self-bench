import type { Difficulty, TaskProgress } from "../contracts.js";

export const VIEWER_MODES = ["runs", "local"] as const;
export type ViewerMode = (typeof VIEWER_MODES)[number];

export interface ViewerInfo {
  readonly modes: readonly ViewerMode[];
  readonly root?: string;
}

export interface TaskFileEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly text?: string;
}

export interface TaskFiles {
  readonly taskId: string;
  readonly files: readonly TaskFileEntry[];
}

export interface LocalTaskSummary {
  readonly taskId: string;
  readonly path: string;
  readonly name?: string;
  readonly difficulty?: string;
  readonly fileCount: number;
}

export const CANDIDATE_STAGES = [
  "discovery",
  "authoring",
  "environment",
  "audit",
  "preflight",
  "validation",
  "review",
  "export",
  "infrastructure",
  "accepted",
  "in_progress",
] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

export interface CandidateDefinitionSummary {
  readonly testCommand: string;
  readonly runner: string;
  readonly failToPass: number;
  readonly passToPass: number;
  readonly testPaths: number;
  readonly workdir: string;
  readonly sourcePr: number;
  readonly sourceUrl: string;
  readonly baseCommit: string;
}

export interface CandidateSummary extends Omit<TaskProgress, "status"> {
  /** "archived" when Temporal no longer has the run and the verdict is inferred from artifacts. */
  readonly status: TaskProgress["status"] | "archived";
  readonly stage: CandidateStage;
  readonly reasonSummary?: string;
  readonly definition?: CandidateDefinitionSummary;
}

export interface CandidateList {
  readonly runId: string;
  readonly phase: string;
  readonly requestedByDifficulty?: Readonly<Record<Difficulty, number>>;
  readonly candidates: readonly CandidateSummary[];
}

export interface ArtifactEntry {
  readonly key: string;
  readonly sizeBytes: number;
  readonly updatedAt?: string;
}

export const BUNDLE_STAGES = [
  "verification",
  "verify",
  "authoring",
  "environment",
  "validation-repair",
  "repair",
] as const;
export type BundleStage = (typeof BUNDLE_STAGES)[number];

export interface BundleRef extends ArtifactEntry {
  readonly stage: BundleStage;
}

export const ARTIFACT_GROUPS = [
  "verification",
  "verify",
  "authoring",
  "environments",
  "audits",
  "environment-preflights",
  "validation",
  "validation-repairs",
  "reviews",
  "repairs",
  "provenance",
] as const;
export type ArtifactGroup = (typeof ARTIFACT_GROUPS)[number];

export interface CandidateArtifacts {
  readonly runId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly groups: Readonly<Record<ArtifactGroup, readonly ArtifactEntry[]>>;
  readonly bundles: readonly BundleRef[];
}
