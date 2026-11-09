import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendApiError } from "../src/api/http.js";
import { createSiteAuth } from "../src/api/routes/auth.js";
import { createBenchmarkReleaseRoutes } from "../src/api/routes/benchmark-releases.js";
import { createEvaluationRoutes } from "../src/api/routes/evaluations.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { createApiKeyStore } from "../src/db/api-keys.js";
import { createBenchmarkStore } from "../src/db/benchmarks.js";
import { createReleaseStore } from "../src/db/releases.js";
import { createRepoStore } from "../src/db/repos.js";
import { credentials } from "../src/db/schema.js";
import { createTaskStore } from "../src/db/tasks.js";
import { createUserStore } from "../src/db/users.js";
import { saveEvaluation } from "../src/evaluation/store.js";
import { full, names } from "./support/release-fixture.js";
import { sessionFetch } from "./support/session-fetch.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "./support/site-fixture.js";

const NAME = "laude-institute/terminal-bench";
const base = `/api/orgs/acme/benchmarks/${NAME}/releases`;
const CREDENTIAL = "00000000-0000-4000-8000-0000000000aa";
let database: TestDatabase;
let server: Server;
let origin = "";
const changed: string[][] = [];
const request = sessionFetch(() => origin);

/** Workspace acme, with Terminal-Bench added (tasks t1-t3) and two models run on all three. */
beforeAll(async () => {
  database = await testDatabase();
  const artifacts = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "benchmark-releases-")));
  const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
  const priya = await users.upsert({
    ...{ githubId: 1, login: "priya", token: "token-priya", scopes: "repo" },
    orgs: [{ githubId: 900, login: "acme", role: "member" }],
  });
  const tenant = (await users.orgsFor(priya.id)).find((org) => org.login === "acme");
  if (!tenant) throw new Error("missing acme workspace");
  const benchmarks = createBenchmarkStore(database.db);
  const strandedBefore = new Date(0);
  const { benchmark } = await benchmarks.start({
    ...{ orgId: tenant.id, name: NAME, ref: "2.0", addedBy: priya.id, strandedBefore },
  });
  await benchmarks.finish(
    benchmark.id,
    names(1, 3).map((taskId) => ({ runId: "gen", taskId, bundleKey: `tasks/${taskId}.tar.gz` })),
  );
  await database.db.insert(credentials).values({
    ...{ id: CREDENTIAL, orgId: tenant.id, name: "OpenAI", kind: "openai", auth: "api-key" },
  });
  for (const model of ["sol", "luna"]) {
    const { repoId: _, ...run } = full(model, names(1, 3), { credential: CREDENTIAL });
    await saveEvaluation(artifacts, { ...run, benchmarkId: benchmark.id });
  }
  const releases = createReleaseStore(database.db);
  const publicRoutes = createPublicReleaseRoutes(releases);
  let routes: ReturnType<typeof createBenchmarkReleaseRoutes> | undefined;
  let evaluations: ReturnType<typeof createEvaluationRoutes> | undefined;
  const auth = createSiteAuth({
    config: testAuthConfig,
    users,
    apiKeys: createApiKeyStore(database.db),
    fetchImpl: (async () => Response.json({ id: 1 })) as unknown as typeof fetch,
  });
  server = createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url ?? "/", origin);
      if (await publicRoutes.handle(incoming, url, response)) return;
      const user = await auth.authenticate(incoming);
      if (!user || !routes || !evaluations) return void response.writeHead(401).end();
      if (await routes.handle(incoming, url, response, user)) return;
      if (!(await evaluations.handle(incoming, url, response, user))) response.writeHead(404).end();
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  // Its same-origin check needs the server's own address.
  routes = createBenchmarkReleaseRoutes({
    ...{ db: database.db, artifacts, users, benchmarks, releases },
    ...{ publicUrl: origin, resultsSiteUrl: "https://selfbench.example" },
    onPublicChange: (paths) => {
      changed.push(paths);
      publicRoutes.refresh();
    },
  });
  evaluations = createEvaluationRoutes({
    ...{ users, repos: createRepoStore(database.db), tasks: createTaskStore(database.db) },
    ...{ artifacts, benchmarks, publicUrl: origin, start: async () => {}, stop: async () => {} },
    publicLines: {
      store: releases,
      changed: (paths) => {
        changed.push(paths);
        publicRoutes.refresh();
      },
    },
  });
});

afterAll(async () => {
  server.close();
  await database.close();
});

/** Releases every setting the preview offers, with `extra` in the body. */
async function release(extra: Record<string, unknown> = {}) {
  const view = await (await request(`${base}/preview`)).json();
  const settings = view.preview.settings.map((setting: { key: string }) => setting.key);
  const body = { settings, head: view.head?.id ?? null, fingerprint: view.preview.fingerprint };
  return request(base, { method: "POST", body: JSON.stringify({ ...body, ...extra }) });
}

test("a public benchmark publishes its scores alone", async () => {
  const refused = await release({ publishTasks: true });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toBe("A public benchmark publishes its scores only.");
});

test("a public benchmark is released and served under /evals, marked as one", async () => {
  const response = await release();
  expect(response.status).toBe(201);
  expect((await response.json()).release).toMatchObject({ tasks: 3, settings: 2, current: true });
  expect(changed.at(-1)).toEqual(["/evals", `/evals/${NAME}`, `/evals/${NAME}/acme`]);

  const served = await request(`/api/public/results/evals/${NAME}`, {}, null);
  expect(served.status).toBe(200);
  const [line] = (await served.json()).lines;
  expect(line.release).toMatchObject({
    repository: { fullName: NAME },
    publisher: { login: "acme" },
    benchmark: { ref: "2.0" },
    tasks: 3,
  });
  expect(line.release.tasksPublished).toBeUndefined();
  // Not a repository's page, though a repository could have the same name.
  expect((await request(`/api/public/results/${NAME}`, {}, null)).status).toBe(404);
  const directory = await (await request("/api/public/results", {}, null)).json();
  expect(directory.cards).toHaveLength(1);
  expect(directory.cards[0]).toMatchObject({ benchmark: { ref: "2.0" }, defaultLine: true });
});

test("deleting a public benchmark takes its results off selfbench.dev", async () => {
  expect((await request(`/api/public/results/evals/${NAME}`, {}, null)).status).toBe(200);
  const deleted = await request(`/api/orgs/acme/benchmarks/${NAME}`, { method: "DELETE" });
  expect(deleted.status).toBe(200);
  expect(changed.at(-1)).toEqual(["/evals", `/evals/${NAME}`, `/evals/${NAME}/acme`]);
  expect((await request(`/api/public/results/evals/${NAME}`, {}, null)).status).toBe(404);
});
