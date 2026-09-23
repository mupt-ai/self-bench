import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { WorkflowIdReusePolicy } from "@temporalio/common";
import type {
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  DiscoveryResult,
  TaskProgress,
} from "../contracts/index.js";
import type { DiscoveryShardInput } from "../generation/activity-types.js";
import type { SandboxCostSnapshot } from "../sandbox/contracts.js";
import { heartbeatCost } from "./activity.js";

type ExecutionSnapshot<T> =
  | { state: "running"; progress?: TaskProgress; cost?: SandboxCostSnapshot }
  | { state: "completed"; result: T }
  | { state: "cancelled" }
  | { state: "failed"; error: string };
export interface BatchExecutions {
  shard(
    id: string,
    input: DiscoveryShardInput,
    queue: string,
  ): Promise<ExecutionSnapshot<DiscoveryResult>>;
  candidate(
    id: string,
    input: CandidateWorkflowInput,
    queue: string,
  ): Promise<ExecutionSnapshot<CandidateWorkflowResult>>;
  cancel(id: string, queue: string): Promise<boolean>;
}

/** Ordinary client starts: no Temporal parent/child relationship or waiting activity slot. */
export function batchExecutions(client: Client): BatchExecutions {
  async function observe<T>(
    id: string,
    type: string,
    input: unknown,
    queue: string,
    candidate: boolean,
  ): Promise<ExecutionSnapshot<T>> {
    return client.connection.withDeadline(Date.now() + 10_000, async () => {
      let handle = client.workflow.getHandle(id);
      let description: Awaited<ReturnType<typeof handle.describe>>;
      try {
        description = await handle.describe();
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
        try {
          await client.workflow.start(type, {
            workflowId: id,
            taskQueue: queue,
            args: [input],
            workflowExecutionTimeout: "14 days",
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          });
        } catch (startError) {
          if (!(startError instanceof WorkflowExecutionAlreadyStartedError)) throw startError;
        }
        // An ambiguous start is safely retried using the same workflow ID.
        description = await handle.describe();
      }
      if (description.type !== type) throw new Error(`Unexpected workflow type for ${id}`);
      handle = client.workflow.getHandle(id, description.runId);
      if (description.status.name === "COMPLETED")
        return { state: "completed", result: (await handle.result()) as T };
      if (description.status.name === "CANCELLED") return { state: "cancelled" };
      if (description.status.name !== "RUNNING")
        return { state: "failed", error: `Workflow ${description.status.name.toLowerCase()}` };
      const pending = client.workflowService
        ? await client.workflowService
            .describeWorkflowExecution({
              namespace: client.options.namespace,
              execution: { workflowId: id, runId: description.runId },
            })
            .then((value) => value.pendingActivities ?? [])
            .catch(() => [])
        : [];
      const cost = pending
        .map((activity) => heartbeatCost(activity.heartbeatDetails?.payloads?.[0]))
        .find((value) => value !== undefined);
      if (!candidate) return { state: "running", ...(cost ? { cost } : {}) };
      const progress = await handle.query<TaskProgress>("candidateStatus").catch(() => undefined);
      return {
        state: "running",
        ...(progress ? { progress } : {}),
        ...(cost ? { cost } : {}),
      };
    });
  }
  return {
    shard: (id, input, queue) =>
      observe(id, "selfBenchDiscoveryShardWorkflow", input, queue, false),
    candidate: (id, input, queue) => observe(id, "selfBenchAuthorWorkflow", input, queue, true),
    async cancel(id, queue) {
      return client.connection.withDeadline(Date.now() + 10_000, async () => {
        const handle = client.workflow.getHandle(id);
        try {
          if ((await handle.describe()).status.name !== "RUNNING") return true;
          await handle.cancel();
          return (await handle.describe()).status.name !== "RUNNING";
        } catch (error) {
          if (error instanceof WorkflowNotFoundError) {
            // Reserve the ID with a no-op tombstone. Whichever start wins is then
            // cancelled; REJECT_DUPLICATE prevents a late paid start after the fence.
            try {
              await client.workflow.start("selfBenchCancelledDispatchWorkflow", {
                workflowId: id,
                taskQueue: queue,
                args: [],
                workflowExecutionTimeout: "1 minute",
                workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
              });
            } catch (startError) {
              if (!(startError instanceof WorkflowExecutionAlreadyStartedError)) throw startError;
            }
            const reserved = client.workflow.getHandle(id);
            if ((await reserved.describe()).status.name === "RUNNING") await reserved.cancel();
            return (await reserved.describe()).status.name !== "RUNNING";
          }
          throw error;
        }
      });
    },
  };
}
