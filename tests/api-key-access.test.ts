import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { createRepoStore } from "../src/site/repo-store.js";
import type { WorkflowSnapshot } from "../src/site/task-status.js";
import { createTaskStore } from "../src/site/task-store.js";
import { mint, signedIn } from "./support/api-keys.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { type AuthServer, fakeGitHub, startAuthServer } from "./support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe("what an api key may reach", () => {
  test("read keys may list but not change anything", async () => {
    server = await startAuthServer({
      fetchImpl: fakeGitHub({ orgs: ["Mupt-AI"], repos: [{ full_name: "Mupt-AI/self-bench" }] })
        .fetch,
    });
    const headers = await signedIn(server);
    const { secret } = await mint(server, headers, { name: "reader", scope: "read" });
    const keyHeaders = { authorization: `Bearer ${secret}` };
    expect((await server.request("/api/orgs/mupt-ai/repos", { headers: keyHeaders })).status).toBe(
      200,
    );
    const blocked = await server.request("/api/orgs/mupt-ai/repos", {
      method: "POST",
      headers: keyHeaders,
      body: JSON.stringify({ fullName: "mupt-ai/self-bench" }),
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "this API key is read-only" });
  });

  test("a single task is readable by run and task id, refreshed against its workflow", async () => {
    const artifacts = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "api-keys-tasks-")));
    const snapshot = mock(async (): Promise<WorkflowSnapshot> => ({ kind: "running" }));
    server = await startAuthServer({
      artifacts,
      status: { snapshot },
      fetchImpl: fakeGitHub({ orgs: ["Mupt-AI"], repos: [{ full_name: "Mupt-AI/self-bench" }] })
        .fetch,
    });
    const headers = await signedIn(server);
    const { secret } = await mint(server, headers, { name: "CI" });
    const keyHeaders = { "x-api-key": secret };
    await server.request("/api/orgs/mupt-ai/repos", {
      method: "POST",
      headers: keyHeaders,
      body: JSON.stringify({ fullName: "mupt-ai/self-bench" }),
    });
    const user = await server.users.findByGitHubId(42);
    const org = (await server.users.orgsFor(user?.id ?? 0)).find((o) => o.kind === "org");
    const repo = await createRepoStore(server.db).find(org?.id ?? 0, "Mupt-AI/self-bench");
    if (!repo) throw new Error("repo missing");
    const taskStore = createTaskStore(server.db);
    await taskStore.upsertMany([
      {
        repoId: repo.id,
        runId: "batch-one",
        candidateId: "w0s1-alpha",
        taskId: "alpha-task",
        pipelineStatus: "accepted",
        stage: "accepted",
        difficulty: "easy",
        bundleKey: "runs/batch-one/bundle.tar.gz",
      },
    ]);
    await taskStore.insertStarted({
      repoId: repo.id,
      runId: "batch-one",
      candidateId: "w0s2-beta",
      taskId: "beta-task",
      pipelineStatus: "in_progress",
      stage: "authoring",
      difficulty: "easy",
      workflowId: "batch-one/candidate/w0s2-beta",
      startedBy: user?.id ?? 0,
    });
    const path = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench/tasks/batch-one";
    const byTask = await server.request(`${path}/alpha-task`, { headers: keyHeaders });
    expect(byTask.status).toBe(200);
    expect(await byTask.json()).toMatchObject({
      task: { runId: "batch-one", taskId: "alpha-task", state: "needs_review" },
    });
    expect(snapshot).toHaveBeenCalledWith("batch-one/candidate/w0s2-beta");
    const byCandidate = await server.request(`${path}/w0s1-alpha`, { headers: keyHeaders });
    expect(byCandidate.status).toBe(200);
    snapshot.mockImplementation(async () => ({
      kind: "failed",
      status: "TERMINATED",
      detail: "worker lost",
    }));
    const running = await server.request(`${path}/beta-task`, { headers: keyHeaders });
    expect((await running.json()).task).toMatchObject({
      state: "failed",
      pipelineStatus: "infrastructure_failed",
    });
    expect((await server.request(`${path}/missing`, { headers: keyHeaders })).status).toBe(404);
  });
});

describe("api keys and evaluation mutations", () => {
  test("a write key may mutate without a browser origin; a read key may not", async () => {
    const fixture = await evaluationServer();
    try {
      const writer = await fixture.apiKeys.create(fixture.user.id, { name: "w", scope: "write" });
      const reader = await fixture.apiKeys.create(fixture.user.id, { name: "r", scope: "read" });
      const body = JSON.stringify({ name: "openai", kind: "openai", value: "model-secret" });
      const foreignOrigin = { origin: "https://evil.example" };
      const cookieCrossSite = await fixture.request(`${fixture.base}/credentials`, {
        method: "POST",
        headers: foreignOrigin,
        body,
      });
      expect(cookieCrossSite.status).toBe(403);
      const keyed = await fixture.request(
        `${fixture.base}/credentials`,
        { method: "POST", headers: { ...foreignOrigin, "x-api-key": writer.secret }, body },
        null,
      );
      expect(keyed.status).toBe(201);
      const listed = await fixture.request(
        `${fixture.base}/credentials`,
        { headers: { "x-api-key": reader.secret } },
        null,
      );
      expect(listed.status).toBe(200);
      expect((await listed.json()).credentials).toHaveLength(1);
      const readOnly = await fixture.request(
        `${fixture.base}/credentials`,
        { method: "POST", headers: { "x-api-key": reader.secret }, body },
        null,
      );
      expect(readOnly.status).toBe(403);
    } finally {
      await fixture.close();
    }
  });
});
