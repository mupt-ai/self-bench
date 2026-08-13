export interface RunSummary {
  runId: string;
  status: string;
  startedAt: string;
  closedAt?: string;
}

export interface TaskProgress {
  taskId: string;
  candidateId: string;
  difficulty: "easy" | "medium" | "hard";
  status: string;
  reason?: string;
}

export interface RunStatus {
  runId: string;
  phase: string;
  requested: number;
  accepted: number;
  rejected: number;
  tasks: TaskProgress[];
  export?: { uri: string; sizeBytes: number; contentType: string };
  error?: string;
}

export interface ExportManifest {
  schemaVersion: number;
  runId: string;
  candidateCounts: Record<string, number>;
  repository: { url: string; commit: string };
  version: Record<string, unknown>;
  acceptedCount: number;
  tasks: { taskId: string; sha256: string }[];
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
