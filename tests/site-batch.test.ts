import { expect, test } from "bun:test";
import { batchSubmissionSchema } from "../src/site/batch-start.js";
import { taskState } from "../src/site/tasks.js";
import { fixture, ROOT } from "./support/batch-fixture.js";

test("counts reject missing, fractional, negative, zero, excessive and client-supplied repository input", () => {
  for (const candidateCounts of [
    { easy: 0, medium: 0, hard: 0 },
    { easy: -1, medium: 2, hard: 0 },
    { easy: 1.5, medium: 0, hard: 0 },
    { easy: 10000, medium: 1, hard: 0 },
    { easy: 1 },
  ]) {
    expect(batchSubmissionSchema.safeParse({ candidateCounts }).success).toBe(false);
  }
  expect(
    batchSubmissionSchema.safeParse({
      candidateCounts: { easy: 1, medium: 0, hard: 0 },
      repository: "evil",
    }).success,
  ).toBe(false);
});

test("authenticated repo start resolves commit, stages readable input, associates before start and lists on reload", async () => {
  const f = await fixture();
  expect((await f.request(ROOT, { headers: { authorization: "" } })).status).toBe(401);
  expect((await f.request(ROOT.replace("team", "outsider"), { method: "POST" })).status).toBe(404);
  const response = await f.start();
  expect(response.status).toBe(202);
  const input = f.started[0];
  if (!input) throw new Error("not started");
  expect(input.repository.commit).toBe("a".repeat(40));
  expect(input.repository.url).toBe("https://github.com/owner/repo");
  expect(input.candidateCounts).toEqual({ easy: 1, medium: 2, hard: 0 });
  expect((await f.artifacts.get(input.provenance)).length).toBe(0);
  expect(JSON.stringify(input)).not.toContain("secret-token");
  expect(f.github[0]).toEndWith("/commits/feature%2Fmain");
  expect((await (await f.request()).json()).batches[0].runId).toBe(input.runId);
  expect((await f.request(`${ROOT}/${input.runId}/cancel`, { method: "POST" })).status).toBe(202);
  expect(f.cancelled).toEqual([input.runId]);
  expect((await f.request(`${ROOT}/batch-unowned/cancel`, { method: "POST" })).status).toBe(404);
});

test("discovery, individual stages, failures, cancellation and Needs Review without overwriting human decisions", async () => {
  const f = await fixture();
  const { runId } = await (await f.start()).json();
  const status = await (await f.request(`${ROOT}/${runId}`)).json();
  expect(status.discovery.failedShards).toBe(1);
  f.setStatus({
    runId,
    phase: "authoring",
    tasks: [
      { candidateId: "c1", taskId: "t1", difficulty: "easy", status: "accepted" },
      { candidateId: "c2", taskId: "t2", difficulty: "hard", status: "verifying", round: 2 },
      {
        candidateId: "c3",
        taskId: "t3",
        difficulty: "medium",
        status: "rejected",
        reason: "tests did not fail",
      },
    ],
  });
  expect((await f.request(`${ROOT}/${runId}`)).status).toBe(200);
  const rows = await f.tasks.listForRepo(f.repo.id);
  const good = rows.find((row) => row.candidateId === "c1");
  if (!good) throw new Error("missing task");
  expect(taskState(good)).toBe("needs_review");
  expect(good.review).toBeUndefined();
  expect(rows.find((row) => row.candidateId === "c2")?.round).toBe(2);
  expect(rows.find((row) => row.candidateId === "c3")?.reason).toBe("tests did not fail");
  await f.tasks.review(good.id, {
    decision: "approve",
    note: "checked",
    userId: f.repo.connectedBy.id,
  });
  f.setStatus({ runId, phase: "cancelled" });
  await f.request(`${ROOT}/${runId}`);
  const after = await f.tasks.listForRepo(f.repo.id);
  expect(after.find((row) => row.candidateId === "c2")?.round).toBe(2);
  expect(after.find((row) => row.candidateId === "c2")?.pipelineStatus).toBe(
    "infrastructure_failed",
  );
  expect(taskState(after.find((row) => row.candidateId === "c1") ?? good)).toBe("accepted");
});

test("invalid input never starts, and ambiguous start failure retains repo ownership", async () => {
  const f = await fixture({ failStart: true });
  expect((await f.request(ROOT, { method: "POST", body: "{" })).status).toBe(400);
  const response = await f.start();
  expect(response.status).toBe(503);
  const body = await response.json();
  expect((await f.runs.runsFor(f.repo.id))[0]?.runId).toBe(body.runId);
  expect(f.started).toHaveLength(0);
});

test("invalid revision and failed association never launch work", async () => {
  const invalid = await fixture({ sha: "main" });
  expect((await invalid.start()).status).toBe(400);
  expect(invalid.started).toHaveLength(0);
  const failed = await fixture({ failAttach: true });
  expect((await failed.start()).status).toBe(500);
  expect(failed.started).toHaveLength(0);
});

test("partial artifacts never invent a rejection or overwrite a known verdict when queries disappear", async () => {
  const f = await fixture();
  const { runId } = await (await f.start()).json();
  for (const candidate of ["pending", "passed", "failed"]) {
    await f.artifacts.put(
      `runs/${runId}/authoring/${candidate}/definition.json`,
      Buffer.from(JSON.stringify({ taskId: candidate, difficulty: "medium" })),
      "application/json",
    );
  }
  await f.artifacts.put(
    `runs/${runId}/authoring/failed/round-1/result.json`,
    Buffer.from(JSON.stringify({ kind: "rejected", reason: "explicit rejection" })),
    "application/json",
  );
  f.setStatus({
    runId,
    phase: "authoring",
    tasks: [
      { candidateId: "passed", taskId: "passed", difficulty: "medium", status: "accepted" },
      { candidateId: "pending", taskId: "pending", difficulty: "medium", status: "verifying" },
    ],
  });
  await f.request(`${ROOT}/${runId}`);
  let rows = await f.tasks.listForRepo(f.repo.id);
  expect(rows.find((row) => row.candidateId === "pending")?.pipelineStatus).toBe("in_progress");
  expect(rows.find((row) => row.candidateId === "pending")?.reason).toBeUndefined();
  expect(rows.find((row) => row.candidateId === "failed")?.pipelineStatus).toBe("rejected");
  f.setStatus({ runId, phase: "authoring" });
  expect((await f.request(`${ROOT}/${runId}`)).status).toBe(200);
  rows = await f.tasks.listForRepo(f.repo.id);
  expect(rows.find((row) => row.candidateId === "pending")?.pipelineStatus).toBe("in_progress");
  expect(rows.find((row) => row.candidateId === "passed")?.pipelineStatus).toBe("accepted");
  f.setStatus({ runId, phase: "cancelled" });
  await f.request(`${ROOT}/${runId}`);
  rows = await f.tasks.listForRepo(f.repo.id);
  expect(rows.find((row) => row.candidateId === "passed")?.pipelineStatus).toBe("accepted");
  expect(rows.find((row) => row.candidateId === "pending")?.pipelineStatus).toBe(
    "infrastructure_failed",
  );
  expect(rows.find((row) => row.candidateId === "pending")?.reason).toContain("cancelled");
  expect(rows.find((row) => row.candidateId === "failed")?.reason).toBe("explicit rejection");
  await f.request(`${ROOT}/${runId}`);
  expect(
    (await f.tasks.listForRepo(f.repo.id)).find((row) => row.candidateId === "passed")
      ?.pipelineStatus,
  ).toBe("accepted");
});
