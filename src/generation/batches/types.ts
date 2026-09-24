import type {
  ArtifactRef,
  Candidate,
  CandidateWorkflowResult,
  DiscoveryResult,
  RunRequest,
  TaskProgress,
} from "../../contracts/index.js";
import type { SandboxCostSnapshot } from "../../sandbox/contracts.js";
import type { DiscoveryShardInput } from "../pipeline/activities.js";

export interface BatchItem {
  workflowId: string;
  cancelled?: boolean;
  /** Committed before an RPC; an ambiguous start remains owned by this batch. */
  dispatchAttempted?: boolean;
  /** Epoch ms of the last successful observation; throttles polling of running executions. */
  observedAt?: number;
  cost?: SandboxCostSnapshot;
  result?: unknown;
  error?: string;
}
interface BatchShard extends BatchItem {
  input: DiscoveryShardInput;
  result?: DiscoveryResult;
}
interface BatchCandidate extends BatchItem {
  candidate: Candidate;
  progress?: TaskProgress;
  result?: CandidateWorkflowResult;
}
/** Phases after which a batch is never reconciled again. */
export const FINISHED_PHASES = ["complete", "failed", "cancelled"] as const;
type BatchPhase =
  | "discovering"
  | "authoring"
  | "exporting"
  | "cancelling"
  | (typeof FINISHED_PHASES)[number];

export function isFinished(phase: BatchPhase): boolean {
  return (FINISHED_PHASES as readonly BatchPhase[]).includes(phase);
}

/** Immutable inputs are recorded before dispatch; only the application advances this record. */
export interface GenerationBatch {
  run: RunRequest;
  taskQueue: string;
  phase: BatchPhase;
  shards: BatchShard[];
  candidates: BatchCandidate[];
  export?: ArtifactRef;
  error?: string;
}
