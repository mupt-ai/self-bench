import { WorkflowIdReusePolicy } from "@temporalio/common";
import {
  defineQuery,
  defineSignal,
  executeChild,
  getExternalWorkflowHandle,
  ParentClosePolicy,
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
import { executeCandidate, initialProgress } from "./workflow/candidate.js";
import { executeRun } from "./workflow/run.js";

export const statusQuery = defineQuery<RunStatus>("status");
export const candidateStatusQuery = defineQuery<TaskProgress>("candidateStatus");
export const candidateProgressSignal = defineSignal<[TaskProgress]>("candidateProgress");

export function candidateWorkflowId(runId: string, candidateId: string): string {
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
  const result = await executeCandidate(input, workflowActivities, (progress) => {
    current = progress;
    if (parentHandle) {
      signals.push(parentHandle.signal(candidateProgressSignal, progress).catch(() => undefined));
    }
  });
  await Promise.all(signals);
  return result;
}

export { executeRun } from "./workflow/run.js";
