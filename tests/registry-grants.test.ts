import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { taskImageRegistry } from "../src/api/routes/registry.js";
import { handleRegistryGrantRoute } from "../src/api/routes/registry-grants.js";
import { createRegistryGrantStore } from "../src/db/registry-grants.js";
import { orgs, repos, tasks, users } from "../src/db/schema.js";
import { REGISTRY_USERNAME } from "../src/sandbox/registry-grant.js";
import { type TestDatabase, testDatabase } from "./support/test-database.js";

// A customer's grant end to end: the operator issues it for accepted tasks, the customer pulls
// those tasks' images (and only those) through the registry endpoint, and revoking cuts it off at
// the next request.

const SECRET = "s".repeat(32);
const REPOSITORY = "us-central1-docker.pkg.dev/selfbench-test/selfbench-tasks";
const UPSTREAM = "https://us-central1-docker.pkg.dev/v2/selfbench-test/selfbench-tasks";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const AGENT = digest("a");
const VERIFIER = digest("b");
const OTHER = digest("c");

let database: TestDatabase | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await database?.close();
  database = undefined;
});

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("insert returned no row");
  return row;
}

async function seeded() {
  database = await testDatabase();
  const { db } = database;
  const user = one(
    await db.insert(users).values({ githubId: 1, login: "op", githubToken: "token" }).returning(),
  );
  const org = one(
    await db.insert(orgs).values({ githubId: 2, login: "mupt-ai", kind: "org" }).returning(),
  );
  const repo = one(
    await db
      .insert(repos)
      .values({
        orgId: org.id,
        githubId: 3,
        fullName: "mupt-ai/self-bench",
        defaultBranch: "main",
        connectedBy: user.id,
      })
      .returning(),
  );
  const task = async (
    candidateId: string,
    status: "accepted" | "rejected",
    images?: { agent: string; verifier: string },
  ) =>
    one(
      await db
        .insert(tasks)
        .values({
          repoId: repo.id,
          runId: "run-1",
          candidateId,
          taskId: candidateId,
          difficulty: "medium",
          pipelineStatus: status,
          stage: "done",
          ...(status === "accepted" ? { reviewDecision: "approve" as const } : {}),
          ...(images ? { images } : {}),
        })
        .returning(),
    ).id;
  return {
    accepted: await task("t1", "accepted", {
      agent: `${REPOSITORY}/task-1@${AGENT}`,
      verifier: `${REPOSITORY}/task-1-tests@${VERIFIER}`,
    }),
    rejected: await task("t2", "rejected", {
      agent: `${REPOSITORY}/task-2@${OTHER}`,
      verifier: `${REPOSITORY}/task-2-tests@${OTHER}`,
    }),
    unexported: await task("t3", "accepted"),
  };
}

/** Artifact Registry stand-in: each of the two images is a single manifest with no layers. */
const upstream = (async (input: string | URL | Request) => {
  const url = String(input);
  for (const [name, image] of [
    ["task-1", AGENT],
    ["task-1-tests", VERIFIER],
    ["task-2", OTHER],
  ] as const)
    if (url === `${UPSTREAM}/${name}/manifests/${image}`)
      return Response.json(
        { layers: [] },
        { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
      );
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function serve(operator = true) {
  if (!database) throw new Error("seed first");
  const store = createRegistryGrantStore(database.db, SECRET, REPOSITORY);
  const registry = taskImageRegistry({
    repository: REPOSITORY,
    token: async () => "upstream-token",
    fetch: upstream,
    customerGrant: (password) => store.resolve(password),
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (await registry(request, url, response, SECRET)) return;
    if (
      await handleRegistryGrantRoute(request, url, response, {
        store,
        origin: "https://api.selfbench.test",
        operator,
      })
    )
      return;
    response.writeHead(418).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
}

const basic = (password: string) => ({
  authorization: `Basic ${Buffer.from(`${REGISTRY_USERNAME}:${password}`).toString("base64")}`,
});

async function issue(origin: string, body: Record<string, unknown>) {
  return await fetch(`${origin}/v1/registry-grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a customer pulls exactly the granted agent images, until the grant is revoked", async () => {
  const ids = await seeded();
  const { origin } = await serve();
  const created = await issue(origin, { label: "Acme", taskIds: [ids.accepted] });
  expect(created.status).toBe(201);
  const grant = (await created.json()) as {
    id: string;
    withVerifier: boolean;
    login: { registry: string; username: string; password: string };
    pulls: string[];
  };
  expect(grant.withVerifier).toBe(false);
  expect(grant.login).toMatchObject({
    registry: "api.selfbench.test",
    username: REGISTRY_USERNAME,
  });
  expect(grant.pulls).toEqual([`api.selfbench.test/task-1@${AGENT}`]);

  const headers = basic(grant.login.password);
  expect((await fetch(`${origin}/v2/task-1/manifests/${AGENT}`, { headers })).status).toBe(200);
  // Not the tests' image unless asked for, and nothing outside the grant.
  expect((await fetch(`${origin}/v2/task-1-tests/manifests/${VERIFIER}`, { headers })).status).toBe(
    404,
  );
  expect((await fetch(`${origin}/v2/task-2/manifests/${OTHER}`, { headers })).status).toBe(404);

  const revoked = await fetch(`${origin}/v1/registry-grants/${grant.id}/revoke`, {
    method: "POST",
  });
  expect(revoked.status).toBe(200);
  expect((await fetch(`${origin}/v2/task-1/manifests/${AGENT}`, { headers })).status).toBe(401);
  // Revoking twice finds no live grant.
  expect(
    (await fetch(`${origin}/v1/registry-grants/${grant.id}/revoke`, { method: "POST" })).status,
  ).toBe(404);
});

test("the verifier image is granted only when asked for", async () => {
  const ids = await seeded();
  const { origin } = await serve();
  const created = await issue(origin, {
    label: "Acme",
    taskIds: [ids.accepted],
    withVerifier: true,
  });
  const grant = (await created.json()) as { login: { password: string }; pulls: string[] };
  expect(grant.pulls).toEqual([
    `api.selfbench.test/task-1@${AGENT}`,
    `api.selfbench.test/task-1-tests@${VERIFIER}`,
  ]);
  const headers = basic(grant.login.password);
  expect((await fetch(`${origin}/v2/task-1-tests/manifests/${VERIFIER}`, { headers })).status).toBe(
    200,
  );
});

test("only accepted tasks with exported images can be granted", async () => {
  const ids = await seeded();
  const { origin } = await serve();
  for (const taskIds of [[ids.rejected], [ids.unexported], [999_999]]) {
    const response = await issue(origin, { label: "Acme", taskIds });
    expect(response.status).toBe(400);
  }
  expect((await issue(origin, { label: "", taskIds: [ids.accepted] })).status).toBe(400);
});

test("expired, forged and unknown passwords are refused", async () => {
  const ids = await seeded();
  const { origin, store } = await serve();
  const { grant, password } = await store.create({
    label: "Acme",
    taskIds: [ids.accepted],
    withVerifier: false,
    expiresAt: new Date(Date.now() - 1),
  });
  expect(grant.images).toEqual([`task-1@${AGENT}`]);
  const live = await store.create({
    label: "Acme",
    taskIds: [ids.accepted],
    withVerifier: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const forged = `${live.password.slice(0, -4)}AAAA`;
  const unknown = live.password.replace(live.grant.id, "00000000-0000-4000-8000-000000000000");
  for (const attempt of [password, forged, unknown])
    expect(
      (await fetch(`${origin}/v2/task-1/manifests/${AGENT}`, { headers: basic(attempt) })).status,
    ).toBe(401);
});

test("only the operator manages grants", async () => {
  const ids = await seeded();
  const { origin } = await serve(false);
  expect((await issue(origin, { label: "Acme", taskIds: [ids.accepted] })).status).toBe(403);
  expect((await fetch(`${origin}/v1/registry-grants`)).status).toBe(403);
});

test("the grant list shows each grant without its password", async () => {
  const ids = await seeded();
  const { origin } = await serve();
  await issue(origin, { label: "Acme", taskIds: [ids.accepted] });
  const listed = (await (await fetch(`${origin}/v1/registry-grants`)).json()) as {
    grants: Record<string, unknown>[];
  };
  expect(listed.grants).toHaveLength(1);
  expect(listed.grants[0]).toMatchObject({ label: "Acme", images: 1, revokedAt: null });
  expect(JSON.stringify(listed)).not.toContain("rg_");
});

test("deleted and unapproved tasks can't be granted, even with images still exported", async () => {
  const ids = await seeded();
  if (!database) throw new Error("seeded");
  const { eq } = await import("drizzle-orm");
  const { origin } = await serve();
  await database.db.update(tasks).set({ reviewDecision: null }).where(eq(tasks.id, ids.accepted));
  expect((await issue(origin, { label: "Acme", taskIds: [ids.accepted] })).status).toBe(400);
  await database.db
    .update(tasks)
    .set({ reviewDecision: "approve", deletedAt: new Date() })
    .where(eq(tasks.id, ids.accepted));
  expect((await issue(origin, { label: "Acme", taskIds: [ids.accepted] })).status).toBe(400);
});
