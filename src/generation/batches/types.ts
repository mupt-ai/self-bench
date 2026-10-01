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
  /** Batches the retired reconciler cancelled carry this instead of an error. */
  cancelled?: boolean;
  /** The running workflow's live sandbox cost; read from Temporal, never stored. */
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
  /** The running workflow's live progress; read from Temporal, never stored. */
  progress?: TaskProgress;
  result?: CandidateWorkflowResult;
}
/** Phases after which a batch never changes again. */
const FINISHED_PHASES = ["complete", "failed", "cancelled"] as const;
type BatchPhase =
  | "preparing"
  | "discovering"
  | "authoring"
  | "exporting"
  | "cancelling"
  | (typeof FINISHED_PHASES)[number];

export function isFinished(phase: BatchPhase): boolean {
  return (FINISHED_PHASES as readonly BatchPhase[]).includes(phase);
}

export const settled = (item: BatchItem) => item.result !== undefined || item.error !== undefined;

/**
 * A batch's record. Its workflow (selfBenchBatchWorkflow) is the only writer, apart from the
 * API marking a cancel; the record carries the plan and settled results, not live progress.
 */
export interface GenerationBatch {
  run: RunRequest;
  taskQueue: string;
  phase: BatchPhase;
  /** When the batch was accepted (epoch ms); a workflow still missing well after it never started. */
  acceptedAt?: number;
  shards: BatchShard[];
  candidates: BatchCandidate[];
  export?: ArtifactRef;
  error?: string;
}
