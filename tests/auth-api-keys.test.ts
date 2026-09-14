import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { LocalArtifactStore } from "../src/artifacts.js";
import { API_KEY_PREFIX, createApiKeyStore, hashApiKey } from "../src/auth/api-keys.js";
import { OAUTH_STATE_COOKIE } from "../src/auth/routes.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { createUserStore } from "../src/auth/users.js";
import { apiKeys } from "../src/db/schema.js";
import { createRepoStore } from "../src/site/repo-store.js";
import { createTaskStore } from "../src/site/task-store.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import {
  type AuthServer,
  cookieValue,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
  testDatabase,
} from "./support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** Signs in through the OAuth flow and returns cookie headers that pass the same-origin check. */
async function signedIn(site: AuthServer) {
  const start = await site.request("/auth/github");
  const state = cookieValue(start, OAUTH_STATE_COOKIE) ?? "";
  const callback = await site.request(`/auth/github/callback?code=c&state=${state}`, {
    headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  });
  const cookie = `${SESSION_COOKIE}=${cookieValue(callback, SESSION_COOKIE) ?? ""}`;
  return { cookie, origin: site.origin, "content-type": "application/json" };
}

async function mint(site: AuthServer, headers: Record<string, string>, body: object) {
  const response = await site.request("/api/api-keys", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    key: { id: number; name: string; prefix: string; scope: string; createdAt: string };
    secret: string;
  };
}

describe("api key store", () => {
  test("mints an unguessable secret, stores only its hash, and resolves it to the owner", async () => {
    const database = await testDatabase();
    try {
      const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
      const user = await users.upsert({
        githubId: 7,
        login: "owner",
        token: "gho",
        scopes: "",
        orgs: [],
      });
      const clock = new Date("2026-09-14T10:00:00Z");
      const store = createApiKeyStore(database.db, { now: () => clock });
      const { key, secret } = await store.create(user.id, { name: "CI", scope: "write" });
      expect(secret.startsWith(API_KEY_PREFIX)).toBe(true);
      expect(secret.length).toBeGreaterThan(40);
      expect(key).toEqual({
        id: key.id,
        name: "CI",
        prefix: secret.slice(0, 12),
        scope: "write",
        createdAt: "2026-09-14T10:00:00.000Z",
      });
      const [row] = await database.db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
      expect(row?.keyHash).toBe(hashApiKey(secret));
      expect(JSON.stringify(row)).not.toContain(secret);

      const resolved = await store.authenticate(secret);
      expect(resolved).toEqual({
        id: user.id,
        githubId: 7,
        login: "owner",
        apiKey: { id: key.id, name: "CI", scope: "write" },
      });
      expect((await store.list(user.id))[0]?.lastUsedAt).toBe("2026-09-14T10:00:00.000Z");
      expect(await store.authenticate(`${API_KEY_PREFIX}not-a-real-key`)).toBeUndefined();
      expect(await store.authenticate("gho")).toBeUndefined();

      expect(await store.revoke(user.id + 1, key.id)).toBe(false);
      expect(await store.revoke(user.id, key.id)).toBe(true);
      expect(await store.revoke(user.id, key.id)).toBe(false);
      expect(await store.authenticate(secret)).toBeUndefined();
      expect(await store.list(user.id)).toEqual([]);
    } finally {
      await database.close();
    }
  });
});

describe("api key routes", () => {
  test("keys are created from a browser session, shown once, and revoked", async () => {
    server = await startAuthServer({ fetchImpl: fakeGitHub().fetch });
    const headers = await signedIn(server);
    const crossSite = await server.request("/api/api-keys", {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: JSON.stringify({ name: "CI" }),
    });
    expect(crossSite.status).toBe(403);
    const invalid = await server.request("/api/api-keys", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "", scope: "admin" }),
    });
    expect(invalid.status).toBe(400);

    const { key, secret } = await mint(server, headers, { name: "CI" });
    expect(key.scope).toBe("write");
    const listed = await server.request("/api/api-keys", { headers });
    const list = (await listed.json()) as { keys: { id: number; prefix: string }[] };
    expect(list.keys.map((entry) => entry.id)).toEqual([key.id]);
    expect(JSON.stringify(list)).not.toContain(secret);

    const fromKey = await server.request("/api/api-keys", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "escalated" }),
    });
    expect(fromKey.status).toBe(403);

    expect(
      (await server.request(`/api/api-keys/${key.id}`, { method: "DELETE", headers })).status,
    ).toBe(200);
    expect(
      (await server.request(`/api/api-keys/${key.id}`, { method: "DELETE", headers })).status,
    ).toBe(404);
    expect((await (await server.request("/api/api-keys", { headers })).json()).keys).toEqual([]);
  });

  test("a key authenticates /api routes through either header; missing, bogus and revoked keys are refused", async () => {
    server = await startAuthServer({
      fetchImpl: fakeGitHub({ orgs: ["Mupt-AI"], repos: [{ full_name: "Mupt-AI/self-bench" }] })
        .fetch,
    });
    const headers = await signedIn(server);
    const { key, secret } = await mint(server, headers, { name: "CI", scope: "write" });

    expect((await server.request("/api/me")).status).toBe(401);
    const bogus = await server.request("/api/me", { headers: { "x-api-key": "sbk_nope" } });
    expect(bogus.status).toBe(401);
    expect(await bogus.json()).toEqual({ error: "invalid API key", code: "invalid_api_key" });

    const bearer = await server.request("/api/me", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toMatchObject({
      auth: "api-key",
      apiKey: { name: "CI", scope: "write" },
      user: { login: "avyay" },
    });
    const explicit = await server.request("/api/me", { headers: { "x-api-key": secret } });
    expect(explicit.status).toBe(200);

    const keyHeaders = { "x-api-key": secret };
    const connected = await server.request("/api/orgs/mupt-ai/repos", {
      method: "POST",
      headers: keyHeaders,
      body: JSON.stringify({ fullName: "mupt-ai/self-bench" }),
    });
    expect(connected.status).toBe(201);
    const one = await server.request("/api/orgs/mupt-ai/repos/Mupt-AI/self-bench", {
      headers: keyHeaders,
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ repo: { fullName: "Mupt-AI/self-bench" } });
    expect(
      (await server.request("/api/orgs/mupt-ai/repos/Mupt-AI/other", { headers: keyHeaders }))
        .status,
    ).toBe(404);

    expect(
      (await server.request(`/api/api-keys/${key.id}`, { method: "DELETE", headers })).status,
    ).toBe(200);
    const revoked = await server.request("/api/orgs/mupt-ai/repos", { headers: keyHeaders });
    expect(revoked.status).toBe(401);
  });

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

  test("a single task is readable by run and task id", async () => {
    const artifacts = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "api-keys-tasks-")));
    server = await startAuthServer({
      artifacts,
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
    await createTaskStore(server.db).upsertMany([
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
    const path = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench/tasks/batch-one";
    const byTask = await server.request(`${path}/alpha-task`, { headers: keyHeaders });
    expect(byTask.status).toBe(200);
    expect(await byTask.json()).toMatchObject({
      task: { runId: "batch-one", taskId: "alpha-task", state: "needs_review" },
    });
    const byCandidate = await server.request(`${path}/w0s1-alpha`, { headers: keyHeaders });
    expect(byCandidate.status).toBe(200);
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
