import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { OAUTH_STATE_COOKIE } from "../src/auth/routes.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { clearArchivedListingCache } from "../src/viewer/archived.js";
import { ingestTasks } from "./support/ingest-tasks.js";
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
  return store;
}

async function signedIn(artifacts: LocalArtifactStore) {
  const hub = fakeGitHub({
    orgs: ["Mupt-AI"],
    pullRequests: {
      46: {
        number: 46,
        merged: true,
        merge_commit_sha: "a".repeat(40),
        title: "Fix parser",
        body: "Handle empty input",
        additions: 80,
        deletions: 30,
        changed_files: 3,
        html_url: "https://github.com/Mupt-AI/self-bench/pull/46",
        user: { login: "author", type: "User" },
      },
    },
    repos: [{ full_name: "Mupt-AI/self-bench" }, { full_name: "Mupt-AI/other" }],
  });
  server = await startAuthServer({
    config: testAuthConfig,
    artifacts,
    fetchImpl: hub.fetch,
    start: async () => {},
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
  const site = server;
  const ingest = (runId: string) => ingestTasks(site, artifacts, "Mupt-AI/self-bench", runId);
  return { site, headers, ingest };
}

const REPO = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench";

describe("task routes", () => {
  test("retired attachment endpoints do not list archives or mutate tasks", async () => {
    const artifacts = await seededStore();
    const { site, headers, ingest } = await signedIn(artifacts);
    await ingest("run-one");
    const before = await (await site.request(`${REPO}/tasks`, { headers })).json();
    for (const [method, path] of [
      ["GET", "/api/runs"],
      ["GET", `${REPO}/runs`],
      ["POST", `${REPO}/runs`],
      ["DELETE", `${REPO}/runs/run-one`],
      ["POST", `${REPO}/sync`],
    ] as const) {
      expect((await site.request(path, { method, headers })).status).toBe(404);
    }
    expect(await (await site.request(`${REPO}/tasks`, { headers })).json()).toEqual(before);
    expect(await artifacts.getByKey("runs/run-one/authoring/c1/definition.json")).toBeDefined();
  });

  test("deletion is authorized, idempotent, durable across ingestion and keeps artifacts", async () => {
    const artifacts = await seededStore();
    const { site, headers, ingest } = await signedIn(artifacts);
    await ingest("run-one");
    await site.request("/api/orgs/mupt-ai/repos", {
      method: "POST",
      headers,
      body: JSON.stringify({ fullName: "Mupt-AI/other" }),
    });
    const path = `${REPO}/tasks/run-one/task-good`;
    expect((await site.request(path, { method: "DELETE" })).status).toBe(401);
    expect(
      (
        await site.request(path.replace("/orgs/mupt-ai/", "/orgs/outsider/"), {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (await site.request(path.replace("/self-bench/", "/other/"), { method: "DELETE", headers }))
        .status,
    ).toBe(404);
    expect((await site.request(`${path}/artifacts`, { headers })).status).toBe(200);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await site.request(path, { method: "DELETE", headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect((await site.request(`${path}/artifacts`, { headers })).status).toBe(404);
    expect(
      (
        await site.request(`${path}/review`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ decision: "approve" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await site.request(`${REPO}/tasks/run-one/missing`, { method: "DELETE", headers })).status,
    ).toBe(404);
    await ingest("run-one");
    const list = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { taskId: string }[];
    };
    expect(list.tasks.map((task) => task.taskId)).toEqual(["task-bad"]);
    expect(
      await (await site.request("/api/orgs/mupt-ai/task-counts", { headers })).json(),
    ).toMatchObject({
      counts: { "Mupt-AI/self-bench": { total: 1, needsReview: 0 } },
    });
    await ingest("run-one");
    const reingested = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { taskId: string }[];
    };
    expect(reingested.tasks.map((task) => task.taskId)).toEqual(["task-bad"]);
    expect((await site.request(path, { method: "DELETE", headers })).status).toBe(200);
    expect(await artifacts.getByKey("runs/run-one/authoring/c1/definition.json")).toBeDefined();
    expect(
      Buffer.from(
        (await artifacts.getByKey(
          "runs/run-one/verification/c1/round-1/attempt-1/verify-1/harbor-task.tar.gz",
        )) ?? new Uint8Array(),
      ).toString(),
    ).toBe("tar");
  });

  test("active generation cannot be deleted even after a human review", async () => {
    const artifacts = await seededStore();
    const { site, headers } = await signedIn(artifacts);
    const started = await site.request(`${REPO}/tasks/from-pr`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pr: "https://github.com/Mupt-AI/self-bench/pull/46" }),
    });
    expect(started.status).toBe(201);
    const { task } = (await started.json()) as {
      task: { runId: string; taskId: string; candidateId: string };
    };
    const path = `${REPO}/tasks/${task.runId}/${task.taskId}`;
    await site.request(`${path}/review`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ decision: "approve" }),
    });
    const response = await site.request(path, { method: "DELETE", headers });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Task generation is still in progress" });
    const list = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: unknown[];
    };
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({
      taskId: task.taskId,
      state: "accepted",
      pipelineStatus: "in_progress",
    });
    await artifacts.put(
      `runs/${task.runId}/authoring/${task.candidateId}/definition.json`,
      Buffer.from(JSON.stringify({ taskId: task.taskId, difficulty: "medium" })),
      "application/json",
    );
    await ingestTasks(site, artifacts, "Mupt-AI/self-bench", task.runId);
    expect((await site.request(path, { method: "DELETE", headers })).status).toBe(409);
  });
});
