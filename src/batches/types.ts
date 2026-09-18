import type {
  ArtifactRef,
  Candidate,
  CandidateWorkflowResult,
  DiscoveryResult,
  RunRequest,
  TaskProgress,
} from "../contracts.js";
import type { DiscoveryShardInput } from "../temporal/activities.js";

interface BatchShard {
  workflowId: string;
  cancelled?: boolean;
  /** Committed before an RPC; an ambiguous start remains owned by this batch. */
  dispatchAttempted?: boolean;
  input: DiscoveryShardInput;
  result?: DiscoveryResult;
  error?: string;
}
interface BatchCandidate {
  workflowId: string;
  cancelled?: boolean;
  /** Committed before an RPC; an ambiguous start remains owned by this batch. */
  dispatchAttempted?: boolean;
  candidate: Candidate;
  progress?: TaskProgress;
  result?: CandidateWorkflowResult;
  error?: string;
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
  /** Round-robin reconciliation cursor; at most one execution RPC group per sweep. */
  cursor?: number;
  export?: ArtifactRef;
  error?: string;
}
