export interface TaskFileEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly text?: string;
}

export interface TaskFiles {
  readonly taskId: string;
  readonly files: readonly TaskFileEntry[];
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
