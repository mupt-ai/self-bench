export interface TaskFileEntry {
  path: string;
  sizeBytes: number;
  text?: string;
}

export interface TaskFiles {
  taskId: string;
  files: TaskFileEntry[];
}

type CandidateStage =
  | "discovery"
  | "authoring"
  | "environment"
  | "audit"
  | "preflight"
  | "validation"
  | "review"
  | "export"
  | "infrastructure"
  | "accepted"
  | "in_progress";

export interface ArtifactEntry {
  key: string;
  sizeBytes: number;
  updatedAt?: string;
}

type BundleStage =
  | "verification"
  | "verify"
  | "authoring"
  | "environment"
  | "validation-repair"
  | "repair";

interface BundleRef extends ArtifactEntry {
  stage: BundleStage;
}

type ArtifactGroup =
  | "verification"
  | "verify"
  | "authoring"
  | "environments"
  | "audits"
  | "environment-preflights"
  | "validation"
  | "validation-repairs"
  | "reviews"
  | "repairs"
  | "provenance";

export interface CandidateArtifacts {
  runId: string;
  taskId: string;
  candidateId: string;
  groups: Record<ArtifactGroup, ArtifactEntry[]>;
  bundles: BundleRef[];
}

/** One row of the ledger, whichever source it came from. */
export interface TaskRow {
  id: string;
  name: string;
  candidateId?: string;
  difficulty?: string;
  status?: string;
  stage?: CandidateStage;
  runner?: string;
  testCommand?: string;
  failToPass?: number;
  passToPass?: number;
  sourcePr?: number;
  sourceUrl?: string;
  reason?: string;
  reasonSummary?: string;
  path?: string;
  fileCount?: number;
}
