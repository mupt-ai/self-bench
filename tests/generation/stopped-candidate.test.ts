import { expect, test } from "bun:test";
import type { CandidateWorkflowInput, CandidateWorkflowResult } from "../../src/contracts/index.js";
import { initialProgress } from "../../src/generation/pipeline/candidate.js";
import { settleStopped, settleVerdict } from "../../src/generation/pipeline/workflows.js";
import { candidate, run } from "../support/workflow-fixture.js";

test("a cancelled candidate settles its row, then deletes every image it built", async () => {
  const input = { run, candidate: candidate("cand", 1) } as CandidateWorkflowInput;
  const result: CandidateWorkflowResult = {
    progress: { ...initialProgress(input.candidate), status: "infrastructure_failed" },
  };
  const calls: string[] = [];
  await settleStopped(input, result, true, {
    settleTask: async ({ cancelled }) => void calls.push(`settle cancelled=${cancelled}`),
    discardCandidateImages: async ({ keep }) => {
      calls.push(`discard keep=${keep.length}`);
      return 0;
    },
    compactCandidateBundles: async () => {
      calls.push("compact");
      return { snapshotsShared: 0, bundlesDeleted: 0, freedBytes: 0, mismatched: [] };
    },
  });
  expect(calls).toEqual(["settle cancelled=true", "discard keep=0", "compact"]);
});

const recording = () => {
  const calls: string[] = [];
  const step =
    (name: string, fails = false) =>
    async ({ result }: { result: CandidateWorkflowResult }) => {
      calls.push(`${name} ${result.progress.status}`);
      if (fails) throw new Error("bundle store down");
    };
  return { calls, step };
};

test("a verdict that publishes nothing settles through the write that waits out outages", async () => {
  const input = { run, candidate: candidate("cand", 1) };
  const { calls, step } = recording();
  const result: CandidateWorkflowResult = {
    progress: { ...initialProgress(input.candidate), status: "rejected" },
  };
  await settleVerdict({ runId: run.runId, candidateId: "cand" }, result, {
    publish: step("publish"),
    record: step("record"),
  });
  expect(calls).toEqual(["record rejected"]);
});

test("an accepted verdict that cannot publish falls back through the unbounded write", async () => {
  const input = { run, candidate: candidate("cand", 1) };
  const { calls, step } = recording();
  const result: CandidateWorkflowResult = {
    progress: { ...initialProgress(input.candidate), status: "accepted" },
  };
  const settled = await settleVerdict({ runId: run.runId, candidateId: "cand" }, result, {
    publish: step("publish", true),
    record: step("record"),
  });
  expect(settled.progress.status).toBe("infrastructure_failed");
  expect(calls).toEqual(["publish accepted", "record infrastructure_failed"]);
});
