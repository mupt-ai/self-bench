import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { OAUTH_STATE_COOKIE } from "../src/auth/routes.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { createMemoryUserStore } from "../src/auth/users.js";
import { createMemoryRepoStore } from "../src/site/repo-store.js";
import { createMemoryTaskStore } from "../src/site/task-store.js";
import { sourcePullRequest, taskState } from "../src/site/tasks.js";
import { clearArchivedListingCache } from "../src/viewer/archived.js";
import {
  type AuthServer,
  cookieValue,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
} from "./support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  clearArchivedListingCache();
});

/** A run with one accepted and one rejected candidate, as the agent pipeline writes them. */
async function seededStore(): Promise<LocalArtifactStore> {
  const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "site-tasks-")));
  const put = (key: string, value: unknown) =>
    store.put(key, Buffer.from(JSON.stringify(value)), "application/json");
  const definition = (taskId: string, sourcePr: number) => ({
    taskId,
    difficulty: "medium",
    repo: "Mupt-AI/self-bench",
    testCommand: "bun test",
    runner: "bun",
    failToPass: ["a"],
    passToPass: [],
    testPaths: ["tests"],
    workdir: ".",
    sourcePr,
    sourceUrl: `https://github.com/Mupt-AI/self-bench/pull/${sourcePr}`,
    baseCommit: "a".repeat(40),
  });
  await put("runs/run-one/authoring/c1/definition.json", definition("task-good", 11));
  await put("runs/run-one/verification/c1/round-1/result.json", { kind: "accepted" });
  await put("runs/run-one/authoring/c2/definition.json", definition("task-bad", 12));
  await put("runs/run-one/authoring/c2/round-1/result.json", {
    kind: "rejected",
    reason: "authoring failed: tests never fail without the solution",
  });
  await put("runs/run-two/authoring/c9/definition.json", definition("task-other", 13));
  // The agent pipeline nests definitions per round; the newest one carries the real difficulty.
  await put("runs/run-three/authoring/c3/round-1/definition.json", {
    ...definition("task-nested", 14),
    difficulty: "easy",
  });
  await put("runs/run-three/authoring/c3/round-2/attempt-1/verify-1/definition.json", {
    ...definition("task-nested", 14),
    difficulty: "hard",
  });
  await put("runs/run-three/verification/c3/round-1/result.json", { kind: "accepted" });
  return store;
}

async function signedIn(artifacts: LocalArtifactStore) {
  const hub = fakeGitHub({ orgs: ["Mupt-AI"], repos: [{ full_name: "Mupt-AI/self-bench" }] });
  server = await startAuthServer({
    config: testAuthConfig,
    users: createMemoryUserStore(),
    repos: createMemoryRepoStore(new Map([[1, "avyay"]])),
    tasks: createMemoryTaskStore(new Map([[1, "avyay"]])),
    artifacts,
    fetchImpl: hub.fetch,
  });
  const start = await server.request("/auth/github");
  const state = cookieValue(start, OAUTH_STATE_COOKIE) ?? "";
  const callback = await server.request(`/auth/github/callback?code=c&state=${state}`, {
    headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  });
  const headers = {
    cookie: `${SESSION_COOKIE}=${cookieValue(callback, SESSION_COOKIE) ?? ""}`,
    "content-type": "application/json",
  };
  await server.request("/api/orgs/mupt-ai/repos", {
    method: "POST",
    headers,
    body: JSON.stringify({ fullName: "Mupt-AI/self-bench" }),
  });
  return { site: server, headers };
}

const REPO = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench";

describe("task routes", () => {
  test("attaches runs from the store and lists their candidates as tasks", async () => {
    const { site, headers } = await signedIn(await seededStore());
    const known = (await (await site.request("/api/runs", { headers })).json()) as {
      runs: { runId: string }[];
    };
    expect(known.runs.map((run) => run.runId).sort()).toEqual(["run-one", "run-three", "run-two"]);

    const attach = (runId: string) =>
      site.request(`${REPO}/runs`, { method: "POST", headers, body: JSON.stringify({ runId }) });
    expect((await attach("run-one")).status).toBe(201);
    expect((await attach("run-none")).status).toBe(404);
    expect(await (await site.request(`${REPO}/runs`, { headers })).json()).toMatchObject({
      runs: [{ runId: "run-one", attachedBy: "avyay" }],
    });

    const tasks = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: Record<string, unknown>[];
    };
    expect(tasks.tasks).toEqual([
      expect.objectContaining({
        runId: "run-one",
        taskId: "task-bad",
        candidateId: "c2",
        difficulty: "medium",
        state: "rejected",
        sourcePr: 12,
      }),
      expect.objectContaining({
        runId: "run-one",
        taskId: "task-good",
        candidateId: "c1",
        state: "needs_review",
        sourcePr: 11,
        sourceUrl: "https://github.com/Mupt-AI/self-bench/pull/11",
      }),
    ]);
    expect((tasks.tasks[0] as { reasonSummary?: string }).reasonSummary).toContain(
      "authoring failed",
    );

    expect((await site.request(`${REPO}/runs/run-one`, { method: "DELETE", headers })).status).toBe(
      200,
    );
    expect(await (await site.request(`${REPO}/tasks`, { headers })).json()).toEqual({ tasks: [] });
  });

  test("reads the newest nested definition for agent-pipeline runs", async () => {
    const { site, headers } = await signedIn(await seededStore());
    await site.request(`${REPO}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId: "run-three" }),
    });
    const tasks = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { taskId: string; difficulty: string; state: string; sourcePr?: number }[];
    };
    expect(tasks.tasks).toEqual([
      expect.objectContaining({
        taskId: "task-nested",
        difficulty: "hard",
        state: "needs_review",
        sourcePr: 14,
      }),
    ]);
  });

  test("a human review overrides the pipeline verdict and can be cleared", async () => {
    const { site, headers } = await signedIn(await seededStore());
    await site.request(`${REPO}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId: "run-one" }),
    });
    const review = await site.request(`${REPO}/tasks/run-one/task-good/review`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ decision: "reject", note: "too coupled to the PR" }),
    });
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({
      review: { decision: "reject", note: "too coupled to the PR", decidedBy: "avyay" },
    });
    const bad = await site.request(`${REPO}/tasks/run-one/task-good/review`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(bad.status).toBe(400);
    const tasks = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { taskId: string; state: string; review?: { decision: string } }[];
    };
    expect(tasks.tasks.find((task) => task.taskId === "task-good")).toMatchObject({
      state: "rejected",
      review: { decision: "reject" },
    });
    expect(
      (await site.request(`${REPO}/tasks/run-one/task-good/review`, { method: "DELETE", headers }))
        .status,
    ).toBe(200);
    const after = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { taskId: string; state: string }[];
    };
    expect(after.tasks.find((task) => task.taskId === "task-good")?.state).toBe("needs_review");
  });

  test("serves a task's artifacts only for attached runs", async () => {
    const { site, headers } = await signedIn(await seededStore());
    expect(
      (await site.request(`${REPO}/tasks/run-one/task-good/artifacts`, { headers })).status,
    ).toBe(404);
    await site.request(`${REPO}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId: "run-one" }),
    });
    const found = await site.request(`${REPO}/tasks/run-one/task-good/artifacts`, { headers });
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      runId: "run-one",
      taskId: "task-good",
      candidateId: "c1",
    });
    expect(
      (await site.request(`${REPO}/tasks/run-one/task-none/artifacts`, { headers })).status,
    ).toBe(404);
    expect((await site.request("/api/orgs/mupt-ai/repos/x/y/tasks", { headers })).status).toBe(404);
  });

  test("falls back to the PR number in the task id", () => {
    expect(sourcePullRequest({ taskId: "w0s0-posthog-pr-91809" }, "PostHog/posthog")).toEqual({
      sourcePr: 91809,
      sourceUrl: "https://github.com/PostHog/posthog/pull/91809",
    });
    expect(sourcePullRequest({ taskId: "w0s1-posthog-pr-93198-mobile" }, "a/b")?.sourcePr).toBe(
      93198,
    );
    expect(sourcePullRequest({ taskId: "no-number-here" }, "a/b")).toBeUndefined();
  });

  test("task state combines pipeline verdict and review", () => {
    expect(taskState({ status: "accepted", stage: "accepted" }, undefined)).toBe("needs_review");
    expect(taskState({ status: "archived", stage: "authoring" }, undefined)).toBe("rejected");
    expect(taskState({ status: "rejected", stage: "review" }, undefined)).toBe("rejected");
    expect(taskState({ status: "authoring", stage: "in_progress" }, undefined)).toBe("in_progress");
    expect(taskState({ status: "accepted", stage: "accepted" }, { decision: "reject" })).toBe(
      "rejected",
    );
    expect(taskState({ status: "rejected", stage: "review" }, { decision: "approve" })).toBe(
      "accepted",
    );
  });
});
