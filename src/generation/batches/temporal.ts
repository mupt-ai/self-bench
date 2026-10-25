import { type Client, WorkflowNotFoundError } from "@temporalio/client";
import { BATCH_RPC_CONCURRENCY } from "../../contracts/config/execution-limits.js";
import { settleWithLimit } from "../../lib/util.js";
import { activityDetail } from "./activity.js";
import type { TaskActivityDetail } from "./progress.js";
import { type GenerationBatch, isFinished, settled } from "./types.js";

export interface ObservedBatch {
  /** The batch with each running child's live cost. */
  batch: GenerationBatch;
  /** Each running candidate's current activity attempt, by candidate ID. */
  activity: Record<string, TaskActivityDetail>;
}

/**
 * Reads a running batch's children from Temporal for what only Temporal knows: each child's
 * current activity attempt and its sandbox's live cost. Nothing read here is written anywhere.
 */
export function batchObserver(client: Client) {
  return async (batch: GenerationBatch): Promise<ObservedBatch> => {
    const activity: Record<string, TaskActivityDetail> = {};
    if (isFinished(batch.phase)) return { batch, activity };
    const live = structuredClone(batch);
    const running = [...live.shards, ...live.candidates].filter((item) => !settled(item));
    // One hung call must not stall the page's poll.
    await client.connection
      .withDeadline(Date.now() + 10_000, () =>
        settleWithLimit(running, BATCH_RPC_CONCURRENCY, async (item) => {
          const description = await client.workflowService.describeWorkflowExecution({
            namespace: client.options.namespace,
            execution: { workflowId: item.workflowId },
          });
          const detail = activityDetail(description.pendingActivities ?? []);
          if (detail.cost) item.cost = detail.cost;
          if ("candidate" in item && !description.workflowExecutionInfo?.closeTime)
            activity[item.candidate.candidateId] = detail;
        }),
      )
      .catch(() => undefined);
    return { batch: live, activity };
  };
}

/** The batch workflow's status name, or undefined when it was never started. */
export async function batchWorkflowStatus(
  client: Client,
  runId: string,
): Promise<string | undefined> {
  try {
    const description = await client.connection.withDeadline(Date.now() + 10_000, () =>
      client.workflow.getHandle(runId).describe(),
    );
    return description.status.name;
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return undefined;
    throw error;
  }
}
