import type { Client } from "@temporalio/client";
import type {
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  TaskProgress,
} from "../contracts.js";
import { candidateStatusQuery, selfBenchCandidateWorkflow } from "../temporal/workflow.js";
import type { WorkflowStarter } from "./task-start.js";
import type { TaskStatusSource, WorkflowSnapshot } from "./task-status.js";

const QUERY_TIMEOUT_MS = 5_000;

/** Starts candidate workflows top-level on the configured task queue. */
export function temporalStarter(client: Client, taskQueue: string): WorkflowStarter {
  return async (workflowId: string, input: CandidateWorkflowInput) => {
    await client.workflow.start(selfBenchCandidateWorkflow, {
      workflowId,
      taskQueue,
      args: [input],
      workflowExecutionTimeout: "3 days",
    });
  };
}

/** Reads a candidate workflow's state: describe, then the status query while it runs. */
export function temporalStatus(client: Client): TaskStatusSource {
  return {
    async snapshot(workflowId): Promise<WorkflowSnapshot> {
      const handle = client.workflow.getHandle(workflowId);
      const description = await handle.describe();
      const status = description.status.name;
      if (status === "RUNNING") {
        const progress = await Promise.race([
          handle.query<TaskProgress>(candidateStatusQuery),
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), QUERY_TIMEOUT_MS),
          ),
        ]).catch(() => undefined);
        return { kind: "running", ...(progress ? { progress } : {}) };
      }
      if (status === "COMPLETED") {
        const result = (await handle.result()) as CandidateWorkflowResult;
        return { kind: "completed", result };
      }
      if (status === "FAILED" || status === "TIMED_OUT" || status === "TERMINATED") {
        return { kind: "failed", status };
      }
      if (status === "CANCELLED") return { kind: "failed", status };
      return { kind: "unknown" };
    },
  };
}
