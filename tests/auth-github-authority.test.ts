import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearerMatches } from "../src/api/http.js";
import { LocalArtifactStore } from "../src/artifacts.js";
import { validateGitHubIdentity } from "../src/auth/github.js";
import { createSiteAuth } from "../src/auth/routes.js";
import { createSessionSigner, SESSION_COOKIE } from "../src/auth/session.js";
import { repos, tasks, users } from "../src/db/schema.js";
import {
  type AuthServer,
  cookieAttributes,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
} from "./support/site-fixture.js";

let site: AuthServer | undefined;
let directory: string | undefined;
afterEach(async () => {
  await site?.stop();
  site = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function fixture() {
  let status = 200;
  let identity = 42;
  let calls = 0;
  let networkFailure = false;
  const hub = fakeGitHub();
  const fetchImpl = (async (input, init) => {
    if (String(input).endsWith("/user")) {
      calls++;
      expect(init?.signal).toBeDefined();
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      if (networkFailure) throw new TypeError("Mock network unavailable");
      return Response.json({ id: identity }, { status });
    }
    return hub.fetch(input, init);
  }) as typeof fetch;
  directory = await mkdtemp(join(tmpdir(), "selfbench-auth-authority-"));
  site = await startAuthServer({ fetchImpl, artifacts: new LocalArtifactStore(directory) });
  const user = await site.users.upsert({
    githubId: 42,
    login: "test-user",
    token: "mock-token",
    scopes: "read:user",
    orgs: [],
  });
  const [tenant] = await site.users.orgsFor(user.id);
  if (!tenant) throw new Error("Missing isolated tenant");
  const [repo] = await site.db
    .insert(repos)
    .values({
      orgId: tenant.id,
      githubId: 100,
      fullName: "test-user/repo",
      defaultBranch: "main",
      connectedBy: user.id,
    })
    .returning();
  if (!repo) throw new Error("Missing isolated repo");
  await site.db.insert(tasks).values({
    repoId: repo.id,
    runId: "run-test",
    candidateId: "candidate",
    taskId: "task-test",
    difficulty: "medium",
    pipelineStatus: "accepted",
    stage: "accepted",
  });
  const cookie = `${SESSION_COOKIE}=${createSessionSigner(testAuthConfig.sessionSecret).issue(42)}`;
  return {
    site,
    fetchImpl,
    cookie,
    calls: () => calls,
    upstream: (nextStatus: number, nextIdentity = 42, offline = false) => {
      status = nextStatus;
      identity = nextIdentity;
      networkFailure = offline;
    },
  };
}

const taskPath = "/api/orgs/test-user/repos/test-user/repo/tasks/run-test/task-test";

test("GitHub failure blocks DELETE with no task or user mutation; valid identity permits deletion", async () => {
  const f = await fixture();
  const beforeTasks = await f.site.db.select().from(tasks);
  const beforeUsers = await f.site.db.select().from(users);
  for (const [status, identity, offline, expected] of [
    [401, 42, false, 401],
    [200, 99, false, 401],
    [403, 42, false, 403],
    [429, 42, false, 429],
    [500, 42, false, 503],
    [200, 42, true, 503],
  ] as const) {
    f.upstream(status, identity, offline);
    const beforeCalls = f.calls();
    const response = await f.site.request(taskPath, {
      method: "DELETE",
      headers: { cookie: f.cookie },
    });
    expect(response.status).toBe(expected);
    expect(f.calls() - beforeCalls).toBe(1);
    expect(cookieAttributes(response, SESSION_COOKIE).includes("Max-Age=0")).toBe(expected === 401);
    expect(await response.json()).toMatchObject({
      code: expected === 401 ? "session_expired" : "github_identity_unavailable",
    });
    expect(await f.site.db.select().from(tasks)).toEqual(beforeTasks);
    expect(await f.site.db.select().from(users)).toEqual(beforeUsers);
  }
  f.upstream(200);
  const valid = await f.site.request(taskPath, { method: "DELETE", headers: { cookie: f.cookie } });
  expect(valid.status).toBe(200);
  expect((await f.site.db.select().from(tasks))[0]?.deletedAt).not.toBeNull();
  f.upstream(401);
  expect((await f.site.request("/api/me", { headers: { cookie: f.cookie } })).status).toBe(401);
});

test("anonymous/login routes avoid identity calls and /api/me checks identity exactly once", async () => {
  const f = await fixture();
  expect((await f.site.request("/api/me")).status).toBe(401);
  expect((await f.site.request("/auth/github")).status).toBe(302);
  expect(f.calls()).toBe(0);
  expect((await f.site.request("/api/me", { headers: { cookie: f.cookie } })).status).toBe(200);
  expect(f.calls()).toBe(1);
});

test("valid CLI bearer bypasses stale cookie validation; missing token cannot authenticate site cookie", async () => {
  const f = await fixture();
  f.upstream(401);
  const auth = createSiteAuth({
    config: testAuthConfig,
    users: f.site.users,
    fetchImpl: f.fetchImpl,
  });
  const request = {
    headers: { cookie: f.cookie, authorization: "Bearer mock-cli-token" },
  } as IncomingMessage;
  expect(bearerMatches(request, "mock-cli-token")).toBe(true);
  expect(await auth.authenticate(request, "mock-cli-token")).toBeUndefined();
  expect(f.calls()).toBe(0);
  await expect(auth.authenticate(request, "wrong-cli-token")).rejects.toMatchObject({
    status: 401,
  });
  const missing = createSiteAuth({
    config: testAuthConfig,
    users: { ...f.site.users, gitHubToken: async () => undefined },
    fetchImpl: f.fetchImpl,
  });
  const before = f.calls();
  await expect(missing.authenticate(request)).rejects.toMatchObject({ status: 401 });
  expect(f.calls()).toBe(before);
});

test("an unresponsive identity check aborts after five seconds and fails closed", async () => {
  const fetchImpl = ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  const started = performance.now();
  await expect(
    validateGitHubIdentity(testAuthConfig, "mock-token", 42, fetchImpl),
  ).rejects.toMatchObject({ status: 503 });
  expect(performance.now() - started).toBeGreaterThanOrEqual(4_900);
}, 10_000);

test("malformed identity responses cannot authenticate a cookie", async () => {
  for (const body of [{}, { id: "42" }, { id: 42.5 }, null]) {
    const fetchImpl = (async (_input: RequestInfo | URL) => Response.json(body)) as typeof fetch;
    await expect(
      validateGitHubIdentity(testAuthConfig, "mock-token", 42, fetchImpl),
    ).rejects.toMatchObject({ status: 503 });
  }
});
