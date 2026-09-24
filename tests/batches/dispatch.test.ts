import { expect, test } from "bun:test";
import { MAX_CONCURRENT_CANDIDATE_WORKFLOWS } from "../../src/contracts/config/execution-limits.js";
import { dispatchLimits, planDispatch } from "../../src/generation/batches/dispatch.js";
import type { GenerationBatch } from "../../src/generation/batches/types.js";
import { candidate, run } from "../support/workflow-fixture.js";

const unlimited = { total: Number.POSITIVE_INFINITY, perOrg: Number.POSITIVE_INFINITY };

function batch(): GenerationBatch {
  return { run, taskQueue: "test", phase: "authoring", shards: [], candidates: [] };
}

test("candidate dispatch plans respect the shared workflow concurrency limit", async () => {
  const state = batch();
  state.phase = "authoring";
  state.shards = [];
  state.candidates = Array.from({ length: MAX_CONCURRENT_CANDIDATE_WORKFLOWS + 2 }, (_, index) => ({
    workflowId: `run/candidate/${index}`,
    ...(index < MAX_CONCURRENT_CANDIDATE_WORKFLOWS - 1 ? { dispatchAttempted: true } : {}),
    candidate: candidate(`candidate-${index}`, index + 1),
  }));

  planDispatch([state], unlimited);

  expect(state.candidates.filter((item) => item.dispatchAttempted)).toHaveLength(
    MAX_CONCURRENT_CANDIDATE_WORKFLOWS,
  );
  expect(state.candidates[MAX_CONCURRENT_CANDIDATE_WORKFLOWS]?.dispatchAttempted).toBeUndefined();
});

test("managed work starts first come, first served within the platform and per-org limits", () => {
  const managed = (runId: string, orgId: number, size: number): GenerationBatch => ({
    ...batch(),
    run: {
      ...run,
      runId,
      generation: {
        ownerId: orgId,
        repoId: 1,
        settings: { sandbox: "managed" },
      } as NonNullable<GenerationBatch["run"]["generation"]>,
    },
    phase: "authoring",
    shards: [],
    candidates: Array.from({ length: size }, (_, index) => ({
      workflowId: `${runId}/candidate/${index}`,
      candidate: candidate(`${runId}-${index}`, index + 1),
    })),
  });
  const started = (state: GenerationBatch) =>
    state.candidates.filter((item) => item.dispatchAttempted).length;
  const older = managed("older", 1, 6);
  const sameOrg = managed("same-org", 1, 3);
  const otherOrg = managed("other-org", 2, 5);
  const byo = { ...managed("byo", 1, 4), run };

  planDispatch([older, sameOrg, otherOrg, byo], { total: 8, perOrg: 5 });

  // Org 1 fills its 5 from its oldest batch; org 2 takes the remaining 3 platform slots.
  expect([started(older), started(sameOrg), started(otherOrg)]).toEqual([5, 0, 3]);
  // Work on an organization's own sandbox account is not limited.
  expect(started(byo)).toBe(4);

  // A finished workflow frees its slot for the oldest waiting work of an eligible org.
  const done = older.candidates[0];
  if (!done) throw new Error("missing candidate");
  done.error = "failed";
  planDispatch([older, sameOrg, otherOrg, byo], { total: 8, perOrg: 5 });
  expect([started(older), started(sameOrg), started(otherOrg)]).toEqual([6, 0, 3]);
});

test("limits default to 100 workflows and 20 per organization", () => {
  expect(dispatchLimits({})).toEqual({ total: 100, perOrg: 20 });
  expect(dispatchLimits({ SELFBENCH_ORG_WORKFLOW_LIMIT: "5" }).perOrg).toBe(5);
  expect(() => dispatchLimits({ SELFBENCH_WORKFLOW_LIMIT: "0" })).toThrow();
});
