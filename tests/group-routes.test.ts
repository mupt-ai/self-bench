import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createSessionSigner, SESSION_COOKIE } from "../src/api/auth/session.js";
import { sendApiError } from "../src/api/http.js";
import { createSiteAuth } from "../src/api/routes/auth.js";
import { createEvaluationRoutes } from "../src/api/routes/evaluations.js";
import { createGroupReleaseRoutes } from "../src/api/routes/group-releases.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { createApiKeyStore } from "../src/db/api-keys.js";
import { createGroupReleaseStore } from "../src/db/group-releases.js";
import { createGroupStore } from "../src/db/groups.js";
import { createReleaseStore } from "../src/db/releases.js";
import { createRepoStore } from "../src/db/repos.js";
import { credentials } from "../src/db/schema.js";
import { createTaskStore } from "../src/db/tasks.js";
import { createUserStore } from "../src/db/users.js";
import { saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationRun } from "../src/evaluation/types.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "./support/site-fixture.js";
import { seedTasks } from "./support/task-rows.js";

let database: TestDatabase;
let server: Server;
let origin = "";
let artifacts: LocalArtifactStore;
let orgId = 0;
let credentialId = "";
/** Each GitHub repository's visibility, as the fake GitHub reports it. */
const isPrivate: Record<number, boolean> = {};
const signer = createSessionSigner(testAuthConfig.sessionSecret);
const REPOS = [
  { githubId: 11, fullName: "pallets/flask", repoId: 0 },
  { githubId: 22, fullName: "django/django", repoId: 0 },
];

beforeAll(async () => {
  database = await testDatabase();
  artifacts = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "group-routes-")));
  const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
  const priya = await users.upsert({
    githubId: 1,
    login: "priya",
    token: "token-priya",
    scopes: "repo",
    orgs: [{ githubId: 900, login: "acme", role: "member" }],
  });
  const tenant = (await users.orgsFor(priya.id)).find((org) => org.login === "acme");
  if (!tenant) throw new Error("missing acme workspace");
  orgId = tenant.id;
  const repos = createRepoStore(database.db);
  for (const repo of REPOS)
    repo.repoId = (
      await repos.connect({
        orgId,
        githubId: repo.githubId,
        fullName: repo.fullName,
        defaultBranch: "main",
        private: false,
        connectedBy: priya.id,
      })
    ).id;
  const tasks = createTaskStore(database.db);
  for (const repo of REPOS) {
    await seedTasks(
      database.db,
      ["t1", "t2"].map((name) => ({
        repoId: repo.repoId,
        runId: `gen-${repo.githubId}`,
        candidateId: `c-${name}`,
        taskId: name,
        pipelineStatus: "accepted" as const,
        bundleKey: `tasks/${repo.githubId}-${name}.tar.gz`,
      })),
    );
    for (const name of ["t1", "t2"]) {
      const task = await tasks.find(repo.repoId, `gen-${repo.githubId}`, name);
      if (task) await tasks.review(task.id, { decision: "approve", note: "", userId: priya.id });
    }
  }
  await database.db
    .insert(credentials)
    .values({ id: crypto.randomUUID(), orgId, name: "OpenAI", kind: "openai", auth: "api-key" });
  credentialId = (await database.db.select().from(credentials))[0]?.id ?? "";
  const githubFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/user")) return Response.json({ id: 1 });
    const id = Number(/\/repositories\/(\d+)$/.exec(url)?.[1]);
    const repo = REPOS.find((each) => each.githubId === id);
    if (!repo) return new Response(null, { status: 404 });
    return Response.json({
      id,
      full_name: repo.fullName,
      private: isPrivate[id] === true,
      archived: false,
      stargazers_count: 10,
      owner: { avatar_url: "https://avatars.example/x.png" },
    });
  }) as typeof fetch;
  const auth = createSiteAuth({
    config: testAuthConfig,
    users,
    apiKeys: createApiKeyStore(database.db),
    fetchImpl: githubFetch,
  });
  const groups = createGroupStore(database.db);
  const groupReleases = createGroupReleaseStore(database.db);
  const publicRoutes = createPublicReleaseRoutes(createReleaseStore(database.db), {
    groups: groupReleases,
  });
  let routes:
    | {
        evaluations: ReturnType<typeof createEvaluationRoutes>;
        releases: ReturnType<typeof createGroupReleaseRoutes>;
      }
    | undefined;
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      if (await publicRoutes.handle(request, url, response)) return;
      const user = await auth.authenticate(request);
      if (!user || !routes) return void response.writeHead(401).end();
      if (await routes.releases.handle(request, url, response, user)) return;
      if (!(await routes.evaluations.handle(request, url, response, user)))
        response.writeHead(404).end();
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  routes = {
    evaluations: createEvaluationRoutes({
      users,
      repos,
      tasks,
      artifacts,
      groups,
      publicUrl: origin,
      start: async () => {},
      stop: async () => {},
    }),
    releases: createGroupReleaseRoutes({
      db: database.db,
      artifacts,
      users,
      repos,
      groups,
      releases: groupReleases,
      publicUrl: origin,
      githubApiUrl: testAuthConfig.githubApiUrl,
      resultsSiteUrl: "https://selfbench.example",
      fetchImpl: githubFetch,
      onPublicChange: () => publicRoutes.refresh(),
    }),
  };
});

afterAll(async () => {
  server.close();
  await database.close();
});

beforeEach(async () => {
  await database.db.execute(sql`truncate table repository_groups, group_releases cascade`);
  for (const repo of REPOS) isPrivate[repo.githubId] = false;
});

const request = (path: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: {
      origin,
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${signer.issue(1)}`,
      ...init.headers,
    },
  });
const json = async <T>(path: string, init?: RequestInit) => (await request(path, init)).json() as T;

const group = { name: "Python Web", slug: "python-web", description: "", repositoryIds: [11, 22] };
const create = () =>
  request("/api/orgs/acme/groups", { method: "POST", body: JSON.stringify(group) });

/** A completed run of `model` on the group, passing the tasks named per repository. */
function groupRun(groupId: number, model: string, passed: Record<number, string[]>): EvaluationRun {
  return {
    id: crypto.randomUUID(),
    groupId,
    tenant: "acme",
    startedBy: "priya",
    createdAt: "2026-10-01T00:00:00Z",
    model,
    modelName: `openai/${model}`,
    harnesses: ["codex"],
    sandbox: "modal",
    credentials: { modelCredentialId: credentialId, sandboxCredentialId: "s", provider: "openai" },
    revision: 1,
    modelLabel: model.toUpperCase(),
    status: "completed",
    trials: REPOS.flatMap((repo) =>
      ["t1", "t2"].map((name) => ({
        taskId: name,
        runId: `gen-${repo.githubId}`,
        harness: "codex" as const,
        status: "completed" as const,
        rewards: { reward: passed[repo.githubId]?.includes(name) ? 1 : 0 },
        log: "",
        steps: [],
        artifacts: [],
        modelVerified: true,
        apiCostUsd: 1,
        finishedAt: "2026-10-01T00:00:00Z",
      })),
    ),
  } as EvaluationRun;
}

test("a group is created from connected repositories and runs on all their tasks", async () => {
  expect((await create()).status).toBe(201);
  const listed = await json<{ groups: { slug: string; tasks: number }[] }>("/api/orgs/acme/groups");
  expect(listed.groups).toMatchObject([{ slug: "python-web", tasks: 4 }]);
  const options = await json<{ tasks: { taskId: string; repository: string }[] }>(
    "/api/orgs/acme/groups/python-web/evaluations/options",
  );
  expect(options.tasks.map((task) => `${task.repository}:${task.taskId}`).sort()).toEqual([
    "django/django:t1",
    "django/django:t2",
    "pallets/flask:t1",
    "pallets/flask:t2",
  ]);
  const unknown = await request("/api/orgs/acme/groups", {
    method: "POST",
    body: JSON.stringify({ ...group, slug: "other", repositoryIds: [11, 99] }),
  });
  expect(unknown.status).toBe(400);
  expect((await create()).status).toBe(409);
});

test("a group's release scores its own runs over the group and on each repository", async () => {
  await create();
  const groupId = (await createGroupStore(database.db).find(orgId, "python-web"))?.id ?? 0;
  await saveEvaluation(artifacts, groupRun(groupId, "sol", { 11: ["t1", "t2"], 22: ["t1"] }));
  const base = "/api/orgs/acme/groups/python-web/releases";
  const view = await json<{
    preview: { fingerprint: string; settings: { key: string }[] };
  }>(`${base}/preview`);
  expect(view.preview.settings).toHaveLength(1);
  const body = {
    settings: view.preview.settings.map((setting) => setting.key),
    head: null,
    fingerprint: view.preview.fingerprint,
  };
  // Only public repositories' groups can be released.
  isPrivate[22] = true;
  const refused = await request(base, { method: "POST", body: JSON.stringify(body) });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain("django/django is private");
  isPrivate[22] = false;
  expect((await request(base, { method: "POST", body: JSON.stringify(body) })).status).toBe(201);

  const page = await request("/api/public/groups/acme/python-web");
  expect(page.status).toBe(200);
  const { group: shown } = await page.json();
  expect(shown).toMatchObject({ name: "Python Web", tasks: 4 });
  expect(shown.settings[0]).toMatchObject({ passed: 3, tasks: 4, accuracy: 75 });
  const scores = shown.members.map(
    (member: {
      repository: { fullName: string };
      scores: Record<string, { accuracy: number }>;
    }) => [member.repository.fullName, Object.values(member.scores)[0]?.accuracy],
  );
  expect(scores).toEqual([
    ["pallets/flask", 100],
    ["django/django", 50],
  ]);
  const directory = await (await request("/api/public/results")).json();
  expect(directory.groups).toMatchObject([{ slug: "python-web" }]);

  // Withdrawing takes it down; deleting the group would leave a release as it was.
  const { releases } = await json<{ releases: { id: string }[] }>(base);
  await request(`${base}/${releases[0]?.id}/withdraw`, { method: "POST" });
  expect((await request("/api/public/groups/acme/python-web")).status).toBe(404);
});
