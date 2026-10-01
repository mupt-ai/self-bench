import { type Client, WorkflowNotFoundError } from "@temporalio/client";
import {
  BATCH_OBSERVE_INTERVAL_MS,
  BATCH_RPC_CONCURRENCY,
} from "../../contracts/config/execution-limits.js";
import type { TaskProgress } from "../../contracts/index.js";
import { settleWithLimit } from "../../lib/util.js";
import { candidateStatusQuery } from "../pipeline/workflows.js";
import { activityDetail } from "./activity.js";
import type { TaskActivityDetail } from "./progress.js";
import { type GenerationBatch, isFinished, settled } from "./types.js";

const ACTIVE = ["authoring", "verifying", "reviewing"];

export interface ObservedBatch {
  /** The batch with each running child's live cost, and each running candidate's progress. */
  batch: GenerationBatch;
  /** Each active candidate's current activity attempt; absent once the batch has finished. */
  activity?: Record<string, TaskActivityDetail>;
}

/**
 * Reads a running batch's children from Temporal: the batch record holds only settled results.
 * Progress comes from a query, which is billed, so each candidate's is re-read at most once per
 * BATCH_OBSERVE_INTERVAL_MS however often the page polls.
 */
export function batchObserver(client: Client) {
  const queried = new Map<string, { at: number; progress: TaskProgress | undefined }>();
  const progress = async (workflowId: string) => {
    const cached = queried.get(workflowId);
    if (cached && Date.now() - cached.at < BATCH_OBSERVE_INTERVAL_MS) return cached.progress;
    const value = await client.workflow
      .getHandle(workflowId)
      .query(candidateStatusQuery)
      .catch(() => cached?.progress);
    queried.set(workflowId, { at: Date.now(), progress: value });
    return value;
  };
  return async (batch: GenerationBatch): Promise<ObservedBatch> => {
    if (isFinished(batch.phase)) return { batch };
    for (const [workflowId, { at }] of queried)
      if (Date.now() - at >= 2 * BATCH_OBSERVE_INTERVAL_MS) queried.delete(workflowId);
    const live = structuredClone(batch);
    const details = new Map<string, TaskActivityDetail>();
    const shards = live.shards.filter((item) => !settled(item));
    const candidates = live.candidates.filter((item) => !settled(item));
    // One hung call must not stall the page's poll.
    await client.connection
      .withDeadline(Date.now() + 10_000, () =>
        settleWithLimit([...shards, ...candidates], BATCH_RPC_CONCURRENCY, async (item) => {
          const description = await client.workflowService.describeWorkflowExecution({
            namespace: client.options.namespace,
            execution: { workflowId: item.workflowId },
          });
          const detail = activityDetail(description.pendingActivities ?? []);
          if (detail.cost) item.cost = detail.cost;
          if (!("candidate" in item) || description.workflowExecutionInfo?.closeTime) return;
          details.set(item.workflowId, detail);
          const current = await progress(item.workflowId);
          if (current) item.progress = current;
        }),
      )
      .catch(() => undefined);
    const activity: Record<string, TaskActivityDetail> = {};
    for (const item of candidates)
      if (item.progress && ACTIVE.includes(item.progress.status))
        activity[item.candidate.candidateId] = details.get(item.workflowId) ?? {
          state: "unknown",
        };
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
