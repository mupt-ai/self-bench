import { defineQuery, setHandler } from "@temporalio/workflow";
import type {
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  DiscoveryResult,
  RunStatus,
  TaskProgress,
} from "../contracts/index.js";
import type { DiscoveryShardInput } from "./activity-types.js";
import { workflowActivities } from "./workflow/activity-proxies.js";
import { executeCandidate, initialProgress } from "./workflow/candidate.js";

export const statusQuery = defineQuery<RunStatus>("status");
export const candidateStatusQuery = defineQuery<TaskProgress>("candidateStatus");

/** Independent discovery unit. Fetching PR metadata and dispatch happen in the application. */
export async function selfBenchDiscoveryShardWorkflow(
  input: DiscoveryShardInput,
): Promise<DiscoveryResult> {
  return workflowActivities.discoverCandidateShard(input);
}

/** Independent author/reviewer loop: no parent progress signals or parent-close policy. */
export async function selfBenchAuthorWorkflow(
  input: CandidateWorkflowInput,
): Promise<CandidateWorkflowResult> {
  let current = initialProgress(input.candidate);
  setHandler(candidateStatusQuery, () => current);
  return executeCandidate(input, workflowActivities, (progress) => {
    current = progress;
  });
}

/** Cancellation tombstone: reserves a never-started dispatch ID without any paid activities. */
export async function selfBenchCancelledDispatchWorkflow(): Promise<void> {}
