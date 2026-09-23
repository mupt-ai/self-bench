import type { Client } from "@temporalio/client";
import type {
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  TaskProgress,
} from "../../contracts/index.js";
import { heartbeatCost } from "../batches/activity.js";
import { candidateStatusQuery, selfBenchAuthorWorkflow } from "../pipeline/workflows.js";
import type { WorkflowStarter } from "./start.js";
import type { TaskStatusSource, WorkflowSnapshot } from "./status.js";

const QUERY_TIMEOUT_MS = 5_000;

/** Starts candidate workflows top-level on the configured task queue. */
export function temporalStarter(client: Client, taskQueue: string): WorkflowStarter {
  return async (workflowId: string, input: CandidateWorkflowInput) => {
    await client.workflow.start(selfBenchAuthorWorkflow, {
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
        const pending = client.workflowService
          ? await client.workflowService
              .describeWorkflowExecution({
                namespace: client.options.namespace,
                execution: { workflowId, runId: description.runId },
              })
              .then((value) => value.pendingActivities ?? [])
              .catch(() => [])
          : [];
        const cost = pending
          .map((activity) => heartbeatCost(activity.heartbeatDetails?.payloads?.[0]))
          .find((value) => value !== undefined);
        const progress = await Promise.race([
          handle.query<TaskProgress>(candidateStatusQuery),
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), QUERY_TIMEOUT_MS),
          ),
        ]).catch(() => undefined);
        return {
          kind: "running",
          ...(progress ? { progress } : {}),
          ...(cost ? { cost } : {}),
        };
      }
      if (status === "COMPLETED") {
        const result = (await handle.result()) as CandidateWorkflowResult;
        return { kind: "completed", result };
      }
      if (status === "FAILED" || status === "TIMED_OUT" || status === "TERMINATED") {
        return { kind: "failed", status };
      }
      if (status === "CANCELLED") return { kind: "cancelled" };
      return { kind: "unknown" };
    },
    async cancel(workflowId) {
      const handle = client.workflow.getHandle(workflowId);
      try {
        await handle.cancel();
      } catch (error) {
        const status = await handle.describe().then((value) => value.status.name);
        if (status === "RUNNING") throw error;
      }
    },
  };
}
