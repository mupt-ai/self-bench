import { expect, test } from "bun:test";
import { batchSubmissionSchema } from "../../src/generation/batches/start.js";
import { fixture, ROOT } from "../support/batch-fixture.js";

test("counts reject missing, fractional, negative, zero, excessive and client-supplied repository input", () => {
  for (const candidateCounts of [
    { easy: 0, medium: 0, hard: 0 },
    { easy: -1, medium: 2, hard: 0 },
    { easy: 1.5, medium: 0, hard: 0 },
    { easy: 301, medium: 0, hard: 0 },
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

test("reading a batch shows its status and writes no task rows", async () => {
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
    ],
  });
  const read = await f.request(`${ROOT}/${runId}`);
  expect((await read.json()).tasks).toHaveLength(2);
  // Rows are the candidate workflows' to write (tests/batches/activities.test.ts).
  expect(await f.tasks.listForRepo(f.repo.id)).toEqual([]);
});

test("a batch focus is trimmed onto the run, and a blank or overlong one never starts", async () => {
  const f = await fixture();
  const post = (focus: unknown) =>
    f.request(ROOT, {
      method: "POST",
      body: JSON.stringify({ candidateCounts: { easy: 1, medium: 0, hard: 0 }, focus }),
    });
  for (const focus of ["   ", "x".repeat(1001), 5]) {
    const response = await post(focus);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Focus must be 1–1000 characters.");
  }
  expect(f.started).toHaveLength(0);
  expect((await post("  Next.js App Router features  ")).status).toBe(202);
  expect(f.started[0]?.focus).toBe("Next.js App Router features");
  expect((await f.start()).status).toBe(202);
  expect(f.started[1]?.focus).toBeUndefined();
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

test("an invalid revision never launches work", async () => {
  const f = await fixture({ sha: "main" });
  expect((await f.start()).status).toBe(400);
  expect(f.started).toHaveLength(0);
});

test("a failed association never launches work", async () => {
  const f = await fixture({ failAttach: true });
  expect((await f.start()).status).toBe(500);
  expect(f.started).toHaveLength(0);
});
