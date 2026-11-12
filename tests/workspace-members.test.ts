import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EvaluationRoutesOptions } from "../src/api/routes/evaluations.js";
import { memberRoutes } from "../src/api/routes/members.js";
import { createUserStore } from "../src/db/users.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "./support/site-fixture.js";

const publicUrl = "http://selfbench.test";
let database: TestDatabase;
let server: Server;
let base: string;
let root: string;

beforeAll(async () => {
  database = await testDatabase();
  const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
  const user = await users.upsert({
    githubId: 1,
    login: "avyay",
    token: "t",
    scopes: "",
    orgs: [{ githubId: 10, login: "Mupt-AI", role: "admin" }],
  });
  const options = {
    users,
    publicUrl,
    githubApiUrl: "https://api.github.test",
    // GitHub knows `taken-on-github`; every other login is free.
    fetch: async (input: string | URL | Request) =>
      new Response("{}", { status: String(input).endsWith("/users/taken-on-github") ? 200 : 404 }),
  } as unknown as EvaluationRoutesOptions;
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", publicUrl);
    if (!(await memberRoutes(options, request, url, response, user))) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orgs`;
  base = `${root}/mupt-ai`;
});
afterAll(async () => {
  server.close();
  await database.close();
});

const post = (path: string, body: unknown, origin = publicUrl) =>
  fetch(`${base}/${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("an admin invites and renames, and the last admin stays an admin", async () => {
  const invited = await post("invites", { login: "Outsider" });
  expect(invited.status).toBe(201);
  expect(await invited.json()).toMatchObject({ githubLogin: "Outsider", role: "member" });
  expect((await post("invites", { login: "not a login" })).status).toBe(400);
  expect(
    ((await (await fetch(`${base}/invites`)).json()) as { invites: unknown[] }).invites,
  ).toHaveLength(1);

  expect(await (await fetch(`${base}/members`)).json()).toMatchObject({
    members: [{ login: "avyay", role: "admin", source: "github" }],
    github: [{ login: "Mupt-AI", kind: "org" }],
    canManage: true,
  });

  const demote = await post("members/avyay/role", { role: "member" });
  expect(demote.status).toBe(409);
  expect(await demote.json()).toEqual({ error: "A workspace needs at least one admin" });

  expect((await post("settings", { name: "Mupt" })).status).toBe(200);
});

test("a cross-site request cannot change membership", async () => {
  expect((await post("invites", { login: "mallory" }, "http://evil.test")).status).toBe(403);
});

test("a new workspace may not take a GitHub account's name", async () => {
  const create = (body: unknown) =>
    fetch(root, {
      method: "POST",
      headers: { origin: publicUrl, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const refused = await create({ login: "taken-on-github" });
  expect(refused.status).toBe(409);
  const made = await create({ login: "mupt-evals", name: "Mupt Evals" });
  expect(made.status).toBe(201);
  expect(await made.json()).toMatchObject({ login: "mupt-evals" });
  expect((await create({ login: "Mupt-Evals" })).status).toBe(409);
});
