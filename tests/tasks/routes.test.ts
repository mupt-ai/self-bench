import { afterEach, describe, expect, test } from "bun:test";
import { taskState } from "../../src/db/task-record.js";
import { seededTaskSite } from "../support/ingest-tasks.js";
import type { AuthServer } from "../support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function signedIn() {
  const fixture = await seededTaskSite();
  server = fixture.site;
  return fixture;
}

const REPO = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench";

describe("task routes", () => {
  test("lists ingested tasks with reason summaries and scoped review counts", async () => {
    const { site, headers, ingest } = await signedIn();
    await ingest();

    const tasks = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: Record<string, unknown>[];
    };
    expect(tasks.tasks).toEqual([
      expect.objectContaining({
        runId: "run-one",
        taskId: "task-bad",
        candidateId: "c2",
        state: "rejected",
        sourcePr: 12,
        reasonSummary: "authoring failed: tests never fail without the solution",
      }),
      expect.objectContaining({
        runId: "run-one",
        taskId: "task-good",
        candidateId: "c1",
        difficulty: "medium",
        state: "needs_review",
        sourcePr: 11,
        sourceUrl: "https://github.com/Mupt-AI/self-bench/pull/11",
      }),
    ]);

    const counts = await site.request("/api/orgs/mupt-ai/task-counts", { headers });
    expect(await counts.json()).toEqual({
      counts: {
        "Mupt-AI/self-bench": { total: 2, accepted: 0, needsReview: 1, rejected: 1, lastPr: 12 },
      },
    });
  });

  test("a human review overrides the pipeline verdict, survives a sync, and can be cleared", async () => {
    const { site, headers, ingest } = await signedIn();
    await ingest();
    const review = await site.request(`${REPO}/tasks/run-one/task-good/review`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ decision: "reject", note: "too coupled to the PR" }),
    });
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({
      task: {
        state: "rejected",
        review: { decision: "reject", note: "too coupled to the PR", decidedBy: "avyay" },
      },
    });
    const bad = await site.request(`${REPO}/tasks/run-one/task-good/review`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(bad.status).toBe(400);
    await ingest();
    const synced = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { taskId: string; state: string }[];
    };
    expect(synced.tasks.find((task) => task.taskId === "task-good")?.state).toBe("rejected");
    const cleared = await site.request(`${REPO}/tasks/run-one/c1/review`, {
      method: "DELETE",
      headers,
    });
    expect(await cleared.json()).toMatchObject({
      task: { taskId: "task-good", state: "needs_review" },
    });
    expect(
      (await site.request(`${REPO}/tasks/run-one/task-none/review`, { method: "DELETE", headers }))
        .status,
    ).toBe(404);
  });

  test("serves a task's artifacts only for synced tasks", async () => {
    const { site, headers, ingest } = await signedIn();
    expect(
      (await site.request(`${REPO}/tasks/run-one/task-good/artifacts`, { headers })).status,
    ).toBe(404);
    await ingest();
    const found = await site.request(`${REPO}/tasks/run-one/task-good/artifacts`, { headers });
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      runId: "run-one",
      taskId: "task-good",
      candidateId: "c1",
      bundles: [expect.objectContaining({ stage: "review" })],
    });
    expect((await site.request("/api/orgs/mupt-ai/repos/x/y/tasks", { headers })).status).toBe(404);
  });

  test("pure helpers: PR fallback and task state", () => {
    expect(taskState({ pipelineStatus: "accepted" })).toBe("needs_review");
    expect(taskState({ pipelineStatus: "rejected" })).toBe("rejected");
    expect(taskState({ pipelineStatus: "in_progress" })).toBe("in_progress");
    expect(taskState({ pipelineStatus: "accepted", review: { decision: "reject" } })).toBe(
      "rejected",
    );
    expect(taskState({ pipelineStatus: "rejected", review: { decision: "approve" } })).toBe(
      "accepted",
    );
  });
});
