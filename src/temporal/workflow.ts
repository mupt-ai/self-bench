import { WorkflowIdReusePolicy } from "@temporalio/common";
import {
  defineQuery,
  defineSignal,
  executeChild,
  getExternalWorkflowHandle,
  ParentClosePolicy,
  patched,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type {
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  RunResult,
  RunStatus,
  TaskProgress,
  WorkflowRunInput,
} from "../contracts.js";
import { workflowActivities } from "./workflow/activity-proxies.js";
import {
  AUTHORING_ROUND_PROTOCOL_PATCH,
  executeCandidate,
  initialProgress,
} from "./workflow/candidate.js";
import { executeRun } from "./workflow/run.js";

export const statusQuery = defineQuery<RunStatus>("status");
export const candidateStatusQuery = defineQuery<TaskProgress>("candidateStatus");
const candidateProgressSignal = defineSignal<[TaskProgress]>("candidateProgress");

function candidateWorkflowId(runId: string, candidateId: string): string {
  return `${runId}/candidate/${candidateId}`;
}

export async function selfBenchRunWorkflow(input: WorkflowRunInput): Promise<RunResult> {
  return await executeRun(
    input,
    workflowActivities,
    (status) => setHandler(statusQuery, () => status()),
    {
      installProgressSignal: (handler) => setHandler(candidateProgressSignal, handler),
      startCandidate: (run, candidate) =>
        executeChild(selfBenchCandidateWorkflow, {
          workflowId: candidateWorkflowId(run.runId, candidate.candidateId),
          args: [{ run, candidate }],
          parentClosePolicy: ParentClosePolicy.TERMINATE,
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        }),
    },
  );
}

/**
 * One candidate per child workflow. Every progress change is signalled to the parent run
 * workflow; the returned result is authoritative even if a signal was lost.
 */
export async function selfBenchCandidateWorkflow(
  input: CandidateWorkflowInput,
): Promise<CandidateWorkflowResult> {
  const parent = workflowInfo().parent;
  const parentHandle = parent
    ? getExternalWorkflowHandle(parent.workflowId, parent.runId)
    : undefined;
  let current = initialProgress(input.candidate);
  setHandler(candidateStatusQuery, () => current);
  const signals: Promise<void>[] = [];
  const legacyAuthoringRoundProtocol = !patched(AUTHORING_ROUND_PROTOCOL_PATCH);
  const result = await executeCandidate(
    input,
    workflowActivities,
    (progress) => {
      current = progress;
      if (parentHandle) {
        signals.push(parentHandle.signal(candidateProgressSignal, progress).catch(() => undefined));
      }
    },
    { legacyAuthoringRoundProtocol },
  );
  await Promise.all(signals);
  return result;
}

export { selfBenchEvaluationWorkflow } from "../evaluation/workflow.js";
export { executeRun } from "./workflow/run.js";

/** Independent discovery unit. Fetching PR metadata and dispatch happen in the application. */
export async function selfBenchDiscoveryShardWorkflow(
  input: import("./activities.js").DiscoveryShardInput,
): Promise<import("../contracts.js").DiscoveryResult> {
  return workflowActivities.discoverCandidateShard(input);
}

/** Independent author/reviewer loop: no parent progress signals or parent-close policy. */
export async function selfBenchAuthorWorkflow(
  input: CandidateWorkflowInput,
): Promise<CandidateWorkflowResult> {
  let current = initialProgress(input.candidate);
  setHandler(candidateStatusQuery, () => current);
  return executeCandidate(
    input,
    workflowActivities,
    (progress) => {
      current = progress;
    },
    { legacyAuthoringRoundProtocol: !patched(AUTHORING_ROUND_PROTOCOL_PATCH) },
  );
}

/** Cancellation tombstone: reserves a never-started dispatch ID without any paid activities. */
export async function selfBenchCancelledDispatchWorkflow(): Promise<void> {}
