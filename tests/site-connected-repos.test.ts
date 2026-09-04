import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { OAUTH_STATE_COOKIE } from "../src/auth/routes.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { createMemoryUserStore, createPostgresUserStore } from "../src/auth/users.js";
import type { SqlClient } from "../src/db/sql.js";
import { createMemoryRepoStore, createPostgresRepoStore } from "../src/site/repo-store.js";
import {
  type AuthServer,
  cookieValue,
  type FakeGitHubOptions,
  fakeGitHub,
  migratedClient,
  startAuthServer,
  testAuthConfig,
} from "./support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function signedIn(github: FakeGitHubOptions) {
  const hub = fakeGitHub(github);
  const users = createMemoryUserStore();
  server = await startAuthServer({
    config: testAuthConfig,
    users,
    repos: createMemoryRepoStore(new Map([[1, "avyay"]])),
    fetchImpl: hub.fetch,
  });
  const start = await server.request("/auth/github");
  const state = cookieValue(start, OAUTH_STATE_COOKIE) ?? "";
  const callback = await server.request(`/auth/github/callback?code=c&state=${state}`, {
    headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  });
  const cookie = `${SESSION_COOKIE}=${cookieValue(callback, SESSION_COOKIE) ?? ""}`;
  return { site: server, hub, headers: { cookie, "content-type": "application/json" } };
}

describe("connected repos routes", () => {
  test("connects a repo the token can read, once, and lists it for the org", async () => {
    const { site, headers } = await signedIn({
      orgs: ["Mupt-AI"],
      repos: [{ full_name: "Mupt-AI/self-bench", private: true }],
    });
    const empty = await site.request("/api/orgs/mupt-ai/repos", { headers });
    expect(await empty.json()).toEqual({ repos: [] });

    const created = await site.request("/api/orgs/mupt-ai/repos", {
      method: "POST",
      headers,
      body: JSON.stringify({ fullName: "mupt-ai/self-bench" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      repo: {
        fullName: "Mupt-AI/self-bench",
        defaultBranch: "main",
        private: true,
        connectedBy: "avyay",
      },
    });
    const again = await site.request("/api/orgs/mupt-ai/repos", {
      method: "POST",
      headers,
      body: JSON.stringify({ fullName: "Mupt-AI/self-bench" }),
    });
    expect(again.status).toBe(200);
    const list = (await (await site.request("/api/orgs/mupt-ai/repos", { headers })).json()) as {
      repos: { fullName: string }[];
    };
    expect(list.repos.map((repo) => repo.fullName)).toEqual(["Mupt-AI/self-bench"]);
  });

  test("allows public repos from anywhere, refuses foreign private ones, bad names, and foreign orgs", async () => {
    const { site, headers } = await signedIn({
      orgs: ["Mupt-AI"],
      repos: [{ full_name: "someone/else", private: true }, { full_name: "posthog/posthog" }],
    });
    const post = (org: string, fullName: string) =>
      site.request(`/api/orgs/${org}/repos`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fullName }),
      });
    expect((await post("mupt-ai", "Mupt-AI/missing")).status).toBe(404);
    expect((await post("mupt-ai", "someone/else")).status).toBe(400);
    expect((await post("mupt-ai", "posthog/posthog")).status).toBe(201);
    expect((await post("mupt-ai", "not a repo")).status).toBe(400);
    expect((await post("other-org", "someone/else")).status).toBe(404);
    expect((await post("avyay", "someone/else")).status).toBe(201);
  });

  test("disconnects by name", async () => {
    const { site, headers } = await signedIn({ orgs: [], repos: [{ full_name: "avyay/x" }] });
    await site.request("/api/orgs/avyay/repos", {
      method: "POST",
      headers,
      body: JSON.stringify({ fullName: "avyay/x" }),
    });
    const gone = await site.request("/api/orgs/avyay/repos/avyay/x", { method: "DELETE", headers });
    expect(gone.status).toBe(200);
    expect(
      (await site.request("/api/orgs/avyay/repos/avyay/x", { method: "DELETE", headers })).status,
    ).toBe(404);
    expect(await (await site.request("/api/orgs/avyay/repos", { headers })).json()).toEqual({
      repos: [],
    });
  });
});

describe("postgres repo store", () => {
  let sql: SqlClient;
  beforeAll(async () => {
    sql = await migratedClient();
  });
  afterAll(async () => {
    await sql.close();
  });

  test("connects, lists newest first, dedupes by GitHub id, and disconnects", async () => {
    const users = createPostgresUserStore(sql, { secret: testAuthConfig.sessionSecret });
    const user = await users.upsert({
      githubId: 1,
      login: "avyay",
      token: "t",
      scopes: "",
      orgs: [{ githubId: 10, login: "Mupt-AI", role: "admin" }],
    });
    const org = (await users.orgsFor(user.id)).find((candidate) => candidate.kind === "org");
    if (!org) throw new Error("org missing");
    let clock = new Date("2026-09-04T10:00:00Z");
    const store = createPostgresRepoStore(sql, { now: () => clock });
    const base = { orgId: org.id, defaultBranch: "main", private: false, connectedBy: user.id };
    await store.connect({ ...base, githubId: 100, fullName: "Mupt-AI/a" });
    clock = new Date("2026-09-04T11:00:00Z");
    const second = await store.connect({ ...base, githubId: 101, fullName: "Mupt-AI/b" });
    expect(second).toMatchObject({
      fullName: "Mupt-AI/b",
      connectedBy: { id: user.id, login: "avyay" },
      connectedAt: "2026-09-04T11:00:00.000Z",
    });
    const renamed = await store.connect({ ...base, githubId: 100, fullName: "Mupt-AI/a-renamed" });
    expect(renamed.id).toBe((await store.find(org.id, "mupt-ai/a-renamed"))?.id ?? -1);
    expect((await store.list(org.id)).map((repo) => repo.fullName)).toEqual([
      "Mupt-AI/b",
      "Mupt-AI/a-renamed",
    ]);
    expect(await store.disconnect(org.id, "MUPT-AI/B")).toBe(true);
    expect(await store.disconnect(org.id, "MUPT-AI/B")).toBe(false);
    expect((await store.list(org.id)).map((repo) => repo.fullName)).toEqual(["Mupt-AI/a-renamed"]);
  });
});
