import type { Client } from "@temporalio/client";
import type { CandidateWorkflowInput } from "../../contracts/index.js";
import type { SandboxCostSnapshot } from "../../sandbox/contracts.js";
import { heartbeatCost } from "../batches/activity.js";
import { selfBenchAuthorWorkflow } from "../pipeline/workflows.js";
import type { WorkflowStarter } from "./start.js";

/** Starts candidate workflows top-level on the configured task queue. */
export function temporalStarter(client: Client, taskQueue: string): WorkflowStarter {
  return async (workflowId: string, input: CandidateWorkflowInput) => {
    await client.workflow.start(selfBenchAuthorWorkflow, { workflowId, taskQueue, args: [input] });
  };
}

/** What the task routes ask Temporal: nothing they write, only cancel and live cost. */
export interface TaskWorkflows {
  cancel(workflowId: string): Promise<void>;
  /** The running sandbox's cost so far, from its activity's heartbeat. */
  liveCost(workflowId: string): Promise<SandboxCostSnapshot | undefined>;
}

export function temporalTaskWorkflows(client: Client): TaskWorkflows {
  return {
    async cancel(workflowId) {
      const handle = client.workflow.getHandle(workflowId);
      try {
        await handle.cancel();
      } catch (error) {
        const status = await handle.describe().then((value) => value.status.name);
        if (status === "RUNNING") throw error;
      }
    },
    async liveCost(workflowId) {
      const pending = await client.workflowService
        .describeWorkflowExecution({
          namespace: client.options.namespace,
          execution: { workflowId },
        })
        .then((value) => value.pendingActivities ?? [])
        .catch(() => []);
      return pending
        .map((activity) => heartbeatCost(activity.heartbeatDetails?.payloads?.[0]))
        .find((value) => value !== undefined);
    },
  };
}
