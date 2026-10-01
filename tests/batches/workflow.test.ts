import { expect, test } from "bun:test";
import { RetryState } from "@temporalio/common";
import { CancelledFailure, ChildWorkflowFailure, TerminatedFailure } from "@temporalio/workflow";
import type { CandidateWorkflowResult, DiscoveryResult } from "../../src/contracts/index.js";
import type { Outcome } from "../../src/generation/batches/record.js";
import { type BatchChildren, runBatch } from "../../src/generation/batches/workflow.js";
import { artifact, candidate, run } from "../support/workflow-fixture.js";

const shardInput = (index: number) => ({
  run,
  wave: 0,
  shardIndex: index,
  shardCount: 2,
  partitioned: true,
  targetCounts: run.candidateCounts,
  excludedSourcePrs: [],
});
const failure = (workflowId: string, cause: Error) =>
  new ChildWorkflowFailure(
    "default",
    { workflowId },
    "selfBenchAuthorWorkflow",
    RetryState.NON_RETRYABLE_FAILURE,
    cause,
  );
const rejected = (id: string): CandidateWorkflowResult => ({
  progress: { candidateId: id, taskId: id, difficulty: "hard", status: "rejected" },
});

/** Activities that record what the workflow asked of them, in order. */
function recording(candidates = ["one", "two", "three"]) {
  const events: string[] = [];
  const outcomes: Record<string, Outcome<unknown>> = {};
  const activities: Parameters<typeof runBatch>[1] = {
    prepareBatch: async () => {
      events.push("prepare");
      return [0, 1].map((index) => ({
        workflowId: `${run.runId}/discovery/${index}`,
        input: shardInput(index),
      }));
    },
    recordBatchShard: async (_runId, index, outcome) => {
      outcomes[`shard ${index}`] = outcome;
    },
    planBatch: async () => {
      events.push("plan");
      return candidates.map((id, index) => ({
        workflowId: `${run.runId}/candidate/${id}`,
        input: { run, candidate: candidate(id, index + 1) },
      }));
    },
    recordBatchCandidate: async (_runId, index, outcome) => {
      outcomes[`candidate ${index}`] = outcome;
    },
    exportBatch: async () => {
      events.push("export");
    },
  };
  return { events, outcomes, activities };
}

test("a batch discovers, plans, authors every candidate and exports, settling each child on its own", async () => {
  const { events, outcomes, activities } = recording();
  const found: DiscoveryResult = { report: artifact, candidates: [candidate("one", 1)] };
  const started: string[] = [];
  const children: BatchChildren = {
    shard: async (workflowId) => {
      started.push(workflowId);
      if (workflowId.endsWith("/1")) throw failure(workflowId, new Error("discovery sandbox died"));
      return found;
    },
    candidate: async (workflowId) => {
      started.push(workflowId);
      if (workflowId.endsWith("/two"))
        throw failure(workflowId, new TerminatedFailure("terminated by operator"));
      if (workflowId.endsWith("/three")) throw failure(workflowId, new CancelledFailure("x"));
      return rejected("one");
    },
  };
  await runBatch(run.runId, activities, children, () => false);
  expect(events).toEqual(["prepare", "plan", "export"]);
  expect(started).toEqual([
    `${run.runId}/discovery/0`,
    `${run.runId}/discovery/1`,
    `${run.runId}/candidate/one`,
    `${run.runId}/candidate/two`,
    `${run.runId}/candidate/three`,
  ]);
  expect(outcomes).toEqual({
    "shard 0": { result: found },
    "shard 1": { error: "discovery sandbox died" },
    "candidate 0": { result: rejected("one") },
    "candidate 1": { error: "terminated by operator" },
    // A candidate cancelled on its own ends as cancelled; the batch carries on.
    "candidate 2": { error: "Generation cancelled." },
  });
});

test("a batch that ends while preparing or planning starts nothing further", async () => {
  const noShards = recording();
  noShards.activities.prepareBatch = async () => [];
  const unused: BatchChildren = {
    shard: async () => {
      throw new Error("must not start");
    },
    candidate: async () => {
      throw new Error("must not start");
    },
  };
  await runBatch(run.runId, noShards.activities, unused, () => false);
  expect(noShards.events).toEqual([]);

  const noCandidates = recording([]);
  await runBatch(
    run.runId,
    noCandidates.activities,
    { ...unused, shard: async () => ({ report: artifact, candidates: [] }) },
    () => false,
  );
  expect(noCandidates.events).toEqual(["prepare", "plan"]);
});

test("a cancelled batch waits for every child to stop, then propagates without exporting", async () => {
  const { events, outcomes, activities } = recording();
  let batchCancelled = false;
  let stopped = 0;
  const children: BatchChildren = {
    shard: async () => ({ report: artifact, candidates: [] }),
    candidate: async (workflowId) => {
      batchCancelled = true;
      await Bun.sleep(workflowId.endsWith("/one") ? 1 : 20);
      stopped += 1;
      throw failure(workflowId, new CancelledFailure("cancelled with the batch"));
    },
  };
  await expect(
    runBatch(run.runId, activities, children, () => batchCancelled),
  ).rejects.toBeInstanceOf(ChildWorkflowFailure);
  expect(stopped).toBe(3);
  expect(events).toEqual(["prepare", "plan"]);
  expect(Object.keys(outcomes).filter((key) => key.startsWith("candidate"))).toEqual([]);
});
