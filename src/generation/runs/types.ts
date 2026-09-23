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

export const AGENT_RECORD_NAME = "agent.json";
/** Written once when the run ends; artifacts are write-once, so `agent.json` is never rewritten. */
export const AGENT_RESULT_NAME = "result.json";

/** What one agent sandbox run records about itself: `agent.json` merged with its `result.json`. */
export interface AgentRunRecord {
  readonly stage: "authoring" | "review";
  readonly round: number;
  /** Authoring turns within a round; each `verify` ends one. */
  readonly turn?: number;
  /** The Temporal activity attempt. */
  readonly attempt: number;
  /** The directory holding this run's prompt, live feed, and log. */
  readonly prefix: string;
  /** Where the pi session is stored once the run ends. */
  readonly session?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  /** Set when the run itself failed (sandbox or provider error) rather than finishing. */
  readonly error?: string;
}

/** The fields `result.json` adds to a run's `agent.json`. */
export type AgentRunResult = Pick<AgentRunRecord, "finishedAt" | "exitCode" | "error">;

export interface CandidateArtifacts {
  readonly runId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly groups: Readonly<Record<ArtifactGroup, readonly ArtifactEntry[]>>;
  readonly bundles: readonly BundleRef[];
  /** Every agent sandbox run, from the `agent.json` and `result.json` each one writes. */
  readonly agents: readonly AgentRunRecord[];
}
