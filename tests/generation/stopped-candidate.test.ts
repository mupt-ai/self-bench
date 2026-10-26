import { expect, test } from "bun:test";
import type { CandidateWorkflowInput, CandidateWorkflowResult } from "../../src/contracts/index.js";
import { initialProgress } from "../../src/generation/pipeline/candidate.js";
import { settleStopped } from "../../src/generation/pipeline/workflows.js";
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
