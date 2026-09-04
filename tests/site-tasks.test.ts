import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { OAUTH_STATE_COOKIE } from "../src/auth/routes.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { sourcePullRequest } from "../src/site/task-sync.js";
import { taskState } from "../src/site/tasks.js";
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
  const definition = (taskId: string, sourcePr: number, difficulty = "medium") => ({
    taskId,
    difficulty,
    repo: "Mupt-AI/self-bench",
    testCommand: "bun test",
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
  await store.put(
    "runs/run-one/verification/c1/round-1/attempt-1/verify-1/harbor-task.tar.gz",
    Buffer.from("tar"),
    "application/gzip",
  );
  await put("runs/run-one/authoring/c2/definition.json", definition("task-bad", 12));
  await put("runs/run-one/authoring/c2/round-1/result.json", {
    kind: "rejected",
    reason: "authoring failed: tests never fail without the solution\nmore detail",
  });
  await put("runs/run-two/authoring/c9/definition.json", definition("task-other", 13));
  // The agent pipeline nests definitions per round; the newest one carries the real difficulty.
  await put("runs/run-three/authoring/c3/round-1/definition.json", definition("task-nested", 14));
  await put(
    "runs/run-three/authoring/c3/round-2/attempt-1/verify-1/definition.json",
    definition("task-nested", 14, "hard"),
  );
  await put("runs/run-three/verification/c3/round-1/result.json", { kind: "accepted" });
  return store;
}

async function signedIn(artifacts: LocalArtifactStore) {
  const hub = fakeGitHub({ orgs: ["Mupt-AI"], repos: [{ full_name: "Mupt-AI/self-bench" }] });
  server = await startAuthServer({
    config: testAuthConfig,
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
  const attach = (runId: string) =>
    server?.request(`${REPO}/runs`, { method: "POST", headers, body: JSON.stringify({ runId }) });
  return { site: server, headers, attach };
}

const REPO = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench";

describe("task routes", () => {
  test("attaching a run syncs its candidates into task rows", async () => {
    const { site, headers, attach } = await signedIn(await seededStore());
    const known = (await (await site.request("/api/runs", { headers })).json()) as {
      runs: { runId: string }[];
    };
    expect(known.runs.map((run) => run.runId).sort()).toEqual(["run-one", "run-three", "run-two"]);

    const attached = await attach("run-one");
    expect(attached?.status).toBe(201);
    expect(await attached?.json()).toMatchObject({ run: { runId: "run-one" }, synced: 2 });
    expect((await attach("run-none"))?.status).toBe(404);

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

    expect((await site.request(`${REPO}/runs/run-one`, { method: "DELETE", headers })).status).toBe(
      200,
    );
    expect(await (await site.request(`${REPO}/tasks`, { headers })).json()).toEqual({ tasks: [] });
  });

  test("reads the newest nested definition and refreshes on sync", async () => {
    const store = await seededStore();
    const { site, headers, attach } = await signedIn(store);
    await attach("run-three");
    const before = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { taskId: string; difficulty: string; state: string; sourcePr?: number }[];
    };
    expect(before.tasks).toEqual([
      expect.objectContaining({
        taskId: "task-nested",
        difficulty: "hard",
        state: "needs_review",
        sourcePr: 14,
      }),
    ]);
    await store.put(
      "runs/run-three/verification/c3/round-2/result.json",
      Buffer.from(JSON.stringify({ kind: "rejected", reason: "verifier: leaks the solution" })),
      "application/json",
    );
    clearArchivedListingCache();
    const sync = await site.request(`${REPO}/sync`, { method: "POST", headers });
    expect(await sync.json()).toEqual({ synced: 1 });
    const after = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { state: string; reasonSummary?: string }[];
    };
    expect(after.tasks[0]).toMatchObject({
      state: "rejected",
      reasonSummary: "verifier: leaks the solution",
    });
  });

  test("a human review overrides the pipeline verdict, survives a sync, and can be cleared", async () => {
    const { site, headers, attach } = await signedIn(await seededStore());
    await attach("run-one");
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
    await site.request(`${REPO}/sync`, { method: "POST", headers });
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
    const { site, headers, attach } = await signedIn(await seededStore());
    expect(
      (await site.request(`${REPO}/tasks/run-one/task-good/artifacts`, { headers })).status,
    ).toBe(404);
    await attach("run-one");
    const found = await site.request(`${REPO}/tasks/run-one/task-good/artifacts`, { headers });
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      runId: "run-one",
      taskId: "task-good",
      candidateId: "c1",
      bundles: [expect.objectContaining({ stage: "verification" })],
    });
    expect((await site.request("/api/orgs/mupt-ai/repos/x/y/tasks", { headers })).status).toBe(404);
  });

  test("pure helpers: PR fallback and task state", () => {
    expect(
      sourcePullRequest({ taskId: "w0s0-posthog-pr-91809" }, undefined, "PostHog/posthog"),
    ).toEqual({
      sourcePr: 91809,
      sourceUrl: "https://github.com/PostHog/posthog/pull/91809",
    });
    expect(
      sourcePullRequest({ taskId: "x" }, { sourcePr: 7, sourceUrl: "https://g/pull/7" }, "a/b"),
    ).toEqual({ sourcePr: 7, sourceUrl: "https://g/pull/7" });
    expect(sourcePullRequest({ taskId: "no-number-here" }, undefined, "a/b")).toBeUndefined();
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
