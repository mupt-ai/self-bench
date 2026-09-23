import type { Difficulty, TaskProgress } from "../contracts/index.js";

export interface TaskFileEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly text?: string;
}

export interface TaskFiles {
  readonly taskId: string;
  readonly files: readonly TaskFileEntry[];
}

const CANDIDATE_STAGES = [
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

/** `stage` is the viewer's pipeline position, derived from status and reason; the progress record's
 * own `stage` (which agent loop is running) is dropped in favor of it. */
export interface CandidateSummary extends Omit<TaskProgress, "status" | "stage"> {
  /** "archived" when Temporal no longer has the run and the verdict is inferred from artifacts. */
  readonly status: TaskProgress["status"] | "archived";
  readonly stage: CandidateStage;
  readonly reasonSummary?: string;
  readonly definition?: CandidateDefinitionSummary;
  /** Archived runs only: where the newest definition.json and final compiled bundle live. */
  /** Artifact reconstruction found an explicit terminal decision, not just partial files. */
  readonly hasVerdict?: boolean;
  readonly definitionKey?: string;
  readonly bundleKey?: string;
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

const BUNDLE_STAGES = [
  "review",
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
  "review",
  /** Legacy artifact group retained so archived runs remain readable. */
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
