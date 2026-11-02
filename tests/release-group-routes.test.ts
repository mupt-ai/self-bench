import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { sql } from "drizzle-orm";
import { createSessionSigner, SESSION_COOKIE } from "../src/api/auth/session.js";
import { sendApiError } from "../src/api/http.js";
import { createSiteAuth } from "../src/api/routes/auth.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import { createReleaseGroupRoutes } from "../src/api/routes/release-groups.js";
import { createApiKeyStore } from "../src/db/api-keys.js";
import { createReleaseGroupStore } from "../src/db/release-groups.js";
import { createReleaseStore, type ReleaseLine } from "../src/db/releases.js";
import { createRepoStore } from "../src/db/repos.js";
import { createUserStore } from "../src/db/users.js";
import {
  RELEASE_SCHEMA_VERSION,
  type ReleasePayload,
  type ReleaseSetting,
} from "../src/public/release-types.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "./support/site-fixture.js";

let database: TestDatabase;
let server: Server;
let origin = "";
let acme = 0;
let changes: string[][] = [];
const releases = () => createReleaseStore(database.db);
const signer = createSessionSigner(testAuthConfig.sessionSecret);

beforeAll(async () => {
  database = await testDatabase();
  const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
  const member = (githubId: number, login: string, orgs: string[]) =>
    users.upsert({
      githubId,
      login,
      token: `token-${login}`,
      scopes: "repo",
      orgs: orgs.map((org, index) => ({ githubId: 900 + index, login: org, role: "member" })),
    });
  const priya = await member(1, "priya", ["acme"]);
  await member(2, "outsider", []);
  const tenant = (await users.orgsFor(priya.id)).find((org) => org.login === "acme");
  if (!tenant) throw new Error("missing acme workspace");
  acme = tenant.id;
  const auth = createSiteAuth({
    config: testAuthConfig,
    users,
    apiKeys: createApiKeyStore(database.db),
    // GitHub confirms each session's person by their token.
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const login = new Headers(init?.headers).get("authorization")?.replace("Bearer token-", "");
      return Response.json({ id: login === "priya" ? 1 : 2 });
    }) as typeof fetch,
  });
  const groups = createReleaseGroupStore(database.db);
  const publicRoutes = createPublicReleaseRoutes(releases(), { groups });
  let routes: ReturnType<typeof createReleaseGroupRoutes> | undefined;
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      if (await publicRoutes.handle(request, url, response)) return;
      const user = await auth.authenticate(request);
      if (!user) return void response.writeHead(401).end();
      if (!(await routes?.handle(request, url, response, user))) response.writeHead(404).end();
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  // The routes check same-origin mutations against the app's own address, known once listening.
  routes = createReleaseGroupRoutes({
    users,
    repos: createRepoStore(database.db),
    releases: releases(),
    groups,
    publicUrl: origin,
    resultsSiteUrl: "https://selfbench.example",
    onPublicChange: (paths) => {
      changes.push(paths);
      publicRoutes.refresh();
    },
  });
});

afterAll(async () => {
  server.close();
  await database.close();
});

beforeEach(async () => {
  changes = [];
  await database.db.execute(sql`truncate table releases, release_groups`);
});

const setting = (id: string, tasks: number, passed: number): ReleaseSetting => ({
  id,
  model: { catalogId: id, name: `openai/${id}`, label: id },
  harness: "codex",
  reasoningLevel: "high",
  provider: "openai",
  custom: false,
  tasks,
  passed,
  accuracy: (passed / tasks) * 100,
  costPerTaskUsd: 1,
  totalCostUsd: tasks,
  costedTasks: tasks,
  onFrontier: true,
});

/** Releases `fullName` as workspace `orgId`, scored by `settings`. */
async function released(orgId: number, id: number, fullName: string, settings: ReleaseSetting[]) {
  const line: ReleaseLine = { orgId, githubRepoId: id };
  const payload: ReleasePayload = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    repository: { id, fullName },
    publisher: { login: orgId === acme ? "acme" : "other", kind: "org" },
    tasks: settings[0]?.tasks ?? 0,
    settings,
    frontier: [],
  };
  const store = releases();
  const head = (await store.list(line))[0];
  return store.insert({
    line,
    fullName,
    publisherLogin: payload.publisher.login,
    ...(head ? { predecessorId: head.id } : {}),
    releasedBy: { id: 1, login: "priya" },
    hash: `${fullName}-${Math.random()}`,
    payload,
    detail: {},
  });
}

const request = (path: string, init: RequestInit = {}, githubId: number | null = 1) =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: {
      origin,
      "content-type": "application/json",
      ...(githubId === null ? {} : { cookie: `${SESSION_COOKIE}=${signer.issue(githubId)}` }),
      ...init.headers,
    },
  });

const create = (body: object, githubId = 1) =>
  request(
    "/api/orgs/acme/release-groups",
    { method: "POST", body: JSON.stringify(body) },
    githubId,
  );

const group = { name: "Web Frameworks", slug: "web", description: "", repositoryIds: [1, 2] };

test("a group pools the workspace's releases of its members on the public API", async () => {
  await released(acme, 1, "a/one", [setting("sol", 10, 8), setting("luna", 10, 2)]);
  await released(acme, 2, "b/two", [setting("sol", 30, 12)]);
  const listed = await (await request("/api/orgs/acme/release-groups")).json();
  expect(listed.candidates.map((each: { fullName: string }) => each.fullName)).toEqual([
    "a/one",
    "b/two",
  ]);

  const response = await create(group);
  expect(response.status).toBe(201);
  const { group: saved } = await response.json();
  expect(saved).toMatchObject({
    slug: "web",
    publicUrl: "https://selfbench.example/groups/acme/web",
    repositories: [
      { id: 1, fullName: "a/one", released: true },
      { id: 2, fullName: "b/two", released: true },
    ],
  });
  expect(changes).toEqual([["/", "/groups/acme/web"]]);

  const page = await request("/api/public/groups/ACME/web", {}, null);
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=10");
  const { group: shown } = await page.json();
  expect(shown).toMatchObject({ name: "Web Frameworks", tasks: 40 });
  expect(shown.settings).toHaveLength(1);
  expect(shown.settings[0]).toMatchObject({ id: "sol", passed: 20, tasks: 40, accuracy: 50 });
  const directory = await (await request("/api/public/results", {}, null)).json();
  expect(directory.groups).toMatchObject([{ slug: "web", repositories: ["a/one", "b/two"] }]);
  expect(JSON.stringify(shown)).not.toContain("priya");
});

test("only released repositories can join, and an address is the workspace's once", async () => {
  await released(acme, 1, "a/one", [setting("sol", 10, 8)]);
  await released(acme, 2, "b/two", [setting("sol", 10, 8)]);
  // Another workspace's release of a repository is not this workspace's to group.
  await released(acme + 1000, 3, "c/three", [setting("sol", 10, 8)]);
  expect((await create({ ...group, repositoryIds: [1, 3] })).status).toBe(400);
  expect((await create({ ...group, repositoryIds: [1] })).status).toBe(400);
  expect((await create({ ...group, slug: "Not Valid" })).status).toBe(400);
  expect((await create(group)).status).toBe(201);
  expect((await create({ ...group, name: "Again" })).status).toBe(409);
  // Outsiders and other sites cannot reach the workspace's groups.
  expect((await create(group, 2)).status).toBe(404);
  const forged = await request("/api/orgs/acme/release-groups", {
    method: "POST",
    body: JSON.stringify(group),
    headers: { origin: "https://evil.example" },
  });
  expect(forged.status).toBe(403);
});

test("a withdrawn member leaves the page, and a deleted group is gone", async () => {
  await released(acme, 1, "a/one", [setting("sol", 10, 8)]);
  const second = await released(acme, 2, "b/two", [setting("sol", 10, 8)]);
  const { group: saved } = await (await create(group)).json();
  await releases().withdraw({ orgId: acme, githubRepoId: 2 }, second.id, "priya");
  const listed = await (await request("/api/orgs/acme/release-groups")).json();
  expect(listed.groups[0].repositories[1]).toMatchObject({ id: 2, released: false });
  const { group: shown } = await (await request("/api/public/groups/acme/web", {}, null)).json();
  expect(shown.members.map((m: { repository: { id: number } }) => m.repository.id)).toEqual([1]);

  // Renaming keeps a withdrawn member that was already there; the old address is told too.
  const renamed = await request(`/api/orgs/acme/release-groups/${saved.id}`, {
    method: "PUT",
    body: JSON.stringify({ ...group, slug: "frameworks" }),
  });
  expect(renamed.status).toBe(200);
  expect(changes.at(-1)).toEqual(["/", "/groups/acme/frameworks", "/groups/acme/web"]);
  expect((await request("/api/public/groups/acme/web", {}, null)).status).toBe(404);

  const deleted = await request(`/api/orgs/acme/release-groups/${saved.id}`, { method: "DELETE" });
  expect(deleted.status).toBe(200);
  const gone = await request("/api/public/groups/acme/frameworks", {}, null);
  expect(gone.status).toBe(404);
  expect(gone.headers.get("cache-control")).toBe("no-store");
});
