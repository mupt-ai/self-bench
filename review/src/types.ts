export interface RunSummary {
  runId: string;
  status: string;
  startedAt?: string;
  closedAt?: string;
}

export interface ViewerInfo {
  modes: ("runs" | "local")[];
  root?: string;
  auth?: "github";
}

export interface TaskFileEntry {
  path: string;
  sizeBytes: number;
  text?: string;
}

export interface TaskFiles {
  taskId: string;
  files: TaskFileEntry[];
}

export interface LocalTaskSummary {
  taskId: string;
  path: string;
  name?: string;
  difficulty?: string;
  fileCount: number;
}

export type CandidateStage =
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

export interface CandidateDefinitionSummary {
  testCommand: string;
  runner: string;
  failToPass: number;
  passToPass: number;
  testPaths: number;
  workdir: string;
  sourcePr: number;
  sourceUrl: string;
  baseCommit: string;
}

export interface CandidateSummary {
  taskId: string;
  candidateId: string;
  difficulty: "easy" | "medium" | "hard";
  status: string;
  reason?: string;
  stage: CandidateStage;
  reasonSummary?: string;
  definition?: CandidateDefinitionSummary;
}

export interface CandidateList {
  runId: string;
  phase: string;
  requestedByDifficulty?: Record<"easy" | "medium" | "hard", number>;
  candidates: CandidateSummary[];
}

export interface ArtifactEntry {
  key: string;
  sizeBytes: number;
  updatedAt?: string;
}

export type BundleStage =
  | "verification"
  | "verify"
  | "authoring"
  | "environment"
  | "validation-repair"
  | "repair";

export interface BundleRef extends ArtifactEntry {
  stage: BundleStage;
}

export type ArtifactGroup =
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

export interface ExportManifest {
  schemaVersion: number;
  runId: string;
  candidateCounts: Record<string, number>;
  repository: { url: string; commit: string };
  version: Record<string, unknown>;
  acceptedCount: number;
  tasks: { taskId: string; sha256: string }[];
  /** Accepted tasks left out because an earlier task in the run shares their source PR. */
  droppedDuplicates?: { taskId: string; sourcePr: number; keptTaskId: string }[];
}

export interface ExportTask {
  taskId: string;
  files: Map<string, Uint8Array>;
  textFiles: Map<string, string>;
}

export interface LoadedExport {
  manifest: ExportManifest;
  tasks: ExportTask[];
  taskArchives: Map<string, Uint8Array>;
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
