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
/** Immutable inputs are recorded before dispatch; only the application advances this record. */
export interface GenerationBatch {
  run: RunRequest;
  taskQueue: string;
  phase:
    | "discovering"
    | "authoring"
    | "exporting"
    | "complete"
    | "failed"
    | "cancelling"
    | "cancelled";
  shards: BatchShard[];
  candidates: BatchCandidate[];
  export?: ArtifactRef;
  error?: string;
}
