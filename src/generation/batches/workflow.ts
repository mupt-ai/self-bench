import {
  CancellationScope,
  ChildWorkflowCancellationType,
  executeChild,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
} from "@temporalio/workflow";
import type {
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  DiscoveryResult,
} from "../../contracts/index.js";
import type { DiscoveryShardInput } from "../pipeline/activities.js";
import {
  rootMessage,
  selfBenchAuthorWorkflow,
  selfBenchDiscoveryShardWorkflow,
} from "../pipeline/workflows.js";
import type { BatchActivities } from "./activities.js";
import { CANCELLED, type Outcome } from "./record.js";

const records = proxyActivities<BatchActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});
// Fetching up to 500 merged PRs; the same fetch finding none again cannot succeed.
const preparing = proxyActivities<Pick<BatchActivities, "prepareBatch">>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 3, nonRetryableErrorTypes: ["NoEligiblePullRequestsError"] },
});
// Packaging accepted bundles in a sandbox.
const exporting = proxyActivities<Pick<BatchActivities, "exportBatch">>({
  startToCloseTimeout: "1 hour",
  retry: { maximumAttempts: 3 },
});
const child = {
  cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
  parentClosePolicy: ParentClosePolicy.TERMINATE,
  workflowExecutionTimeout: "14 days",
};

export interface BatchChildren {
  shard(workflowId: string, input: DiscoveryShardInput): Promise<DiscoveryResult>;
  candidate(workflowId: string, input: CandidateWorkflowInput): Promise<CandidateWorkflowResult>;
}

/**
 * One generation batch, `<runId>`: fetches merged PRs, runs every discovery shard as a child
 * workflow (`<runId>/discovery/<index>`), plans the candidates they found, runs every candidate
 * as a child workflow (`<runId>/candidate/<candidateId>`), and exports the accepted tasks. Each
 * step writes the batch record. Cancelling the batch cancels every child and waits for it to
 * stop; closing it any other way terminates them.
 */
export async function selfBenchBatchWorkflow(runId: string): Promise<void> {
  // A result that lands while a cancel is pending is still recorded.
  const keep =
    <A extends unknown[]>(record: (...args: A) => Promise<void>) =>
    (...args: A) =>
      CancellationScope.nonCancellable(() => record(...args));
  try {
    await runBatch(
      runId,
      {
        prepareBatch: preparing.prepareBatch,
        recordBatchShard: keep(records.recordBatchShard),
        planBatch: records.planBatch,
        recordBatchCandidate: keep(records.recordBatchCandidate),
        exportBatch: exporting.exportBatch,
      },
      {
        shard: (workflowId, input) =>
          executeChild(selfBenchDiscoveryShardWorkflow, { ...child, workflowId, args: [input] }),
        candidate: (workflowId, input) =>
          executeChild(selfBenchAuthorWorkflow, { ...child, workflowId, args: [input] }),
      },
      () => CancellationScope.current().consideredCancelled,
    );
  } catch (error) {
    if (CancellationScope.current().consideredCancelled || isCancellation(error)) {
      await CancellationScope.nonCancellable(() => records.recordBatchCancelled(runId));
      if (isCancellation(error)) throw error;
      return;
    }
    await CancellationScope.nonCancellable(() => records.failBatch(runId, rootMessage(error)));
  }
}

/**
 * The batch's steps. A child that fails, or is cancelled on its own, settles only its own item;
 * once the batch itself is cancelled, every child's end propagates after all of them stop.
 */
export async function runBatch(
  runId: string,
  activities: Pick<
    BatchActivities,
    "prepareBatch" | "recordBatchShard" | "planBatch" | "recordBatchCandidate" | "exportBatch"
  >,
  children: BatchChildren,
  cancelled: () => boolean,
): Promise<void> {
  const outcome = async <T>(run: Promise<T>): Promise<Outcome<T>> => {
    try {
      return { result: await run };
    } catch (error) {
      if (cancelled()) throw error;
      return { error: isCancellation(error) ? CANCELLED : rootMessage(error) };
    }
  };
  const shards = await activities.prepareBatch(runId);
  if (!shards.length) return;
  await all(shards, async ({ workflowId, input }, index) =>
    activities.recordBatchShard(runId, index, await outcome(children.shard(workflowId, input))),
  );
  const candidates = await activities.planBatch(runId);
  if (!candidates.length) return;
  await all(candidates, async ({ workflowId, input }, index) =>
    activities.recordBatchCandidate(
      runId,
      index,
      await outcome(children.candidate(workflowId, input)),
    ),
  );
  await activities.exportBatch(runId);
}

/** Runs every item at once and waits for all of them before reporting the first failure. */
async function all<T>(
  items: readonly T[],
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(items.map(run));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}
