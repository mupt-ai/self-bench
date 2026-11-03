import { afterAll, beforeAll, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createSessionSigner, SESSION_COOKIE } from "../../src/api/auth/session.js";
import { sendApiError } from "../../src/api/http.js";
import { createSiteAuth } from "../../src/api/routes/auth.js";
import { createEvaluationRoutes } from "../../src/api/routes/evaluations.js";
import { createGroupReleaseRoutes } from "../../src/api/routes/group-releases.js";
import { createPublicReleaseRoutes } from "../../src/api/routes/public-releases.js";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { createApiKeyStore } from "../../src/db/api-keys.js";
import { createGroupStore } from "../../src/db/groups.js";
import { createReleaseStore } from "../../src/db/releases.js";
import { createRepoStore } from "../../src/db/repos.js";
import { credentials } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { createUserStore } from "../../src/db/users.js";
import type { EvaluationRun } from "../../src/evaluation/types.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "./site-fixture.js";
import { seedTasks } from "./task-rows.js";

/** What a test reads of the suite: set before its first test runs. */
export const fixture = {
  database: undefined as unknown as TestDatabase,
  artifacts: undefined as unknown as LocalArtifactStore,
  orgId: 0,
};
let server: Server;
let origin = "";
let credentialId = "";
/** Each GitHub repository's visibility, as the fake GitHub reports it. */
export const isPrivate: Record<number, boolean> = {};
const signer = createSessionSigner(testAuthConfig.sessionSecret);
export const REPOS = [
  { githubId: 11, fullName: "pallets/flask", repoId: 0 },
  { githubId: 22, fullName: "django/django", repoId: 0 },
];

/** Registers the suite: a workspace with two connected repositories, each with two approved tasks. */
export function groupSuite() {
  beforeAll(async () => {
    fixture.database = await testDatabase();
    fixture.artifacts = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "group-routes-")));
    const users = createUserStore(fixture.database.db, { secret: testAuthConfig.sessionSecret });
    const priya = await users.upsert({
      githubId: 1,
      login: "priya",
      token: "token-priya",
      scopes: "repo",
      orgs: [{ githubId: 900, login: "acme", role: "member" }],
    });
    const tenant = (await users.orgsFor(priya.id)).find((org) => org.login === "acme");
    if (!tenant) throw new Error("missing acme workspace");
    fixture.orgId = tenant.id;
    const repos = createRepoStore(fixture.database.db);
    for (const repo of REPOS)
      repo.repoId = (
        await repos.connect({
          orgId: fixture.orgId,
          githubId: repo.githubId,
          fullName: repo.fullName,
          defaultBranch: "main",
          private: false,
          connectedBy: priya.id,
        })
      ).id;
    const tasks = createTaskStore(fixture.database.db);
    for (const repo of REPOS) {
      await seedTasks(
        fixture.database.db,
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
    await fixture.database.db.insert(credentials).values({
      id: crypto.randomUUID(),
      orgId: fixture.orgId,
      name: "OpenAI",
      kind: "openai",
      auth: "api-key",
    });
    credentialId = (await fixture.database.db.select().from(credentials))[0]?.id ?? "";
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
      apiKeys: createApiKeyStore(fixture.database.db),
      fetchImpl: githubFetch,
    });
    const groups = createGroupStore(fixture.database.db);
    const groupReleases = createReleaseStore(fixture.database.db);
    const publicRoutes = createPublicReleaseRoutes(groupReleases);
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
        artifacts: fixture.artifacts,
        groups,
        groupReleases: { store: groupReleases, changed: () => publicRoutes.refresh() },
        publicUrl: origin,
        start: async () => {},
        stop: async () => {},
      }),
      releases: createGroupReleaseRoutes({
        db: fixture.database.db,
        artifacts: fixture.artifacts,
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
    await fixture.database.close();
  });

  beforeEach(async () => {
    await fixture.database.db.execute(sql`truncate table repository_groups, releases cascade`);
    for (const repo of REPOS) isPrivate[repo.githubId] = false;
  });
}

export const request = (path: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: {
      origin,
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${signer.issue(1)}`,
      ...init.headers,
    },
  });
export const json = async <T>(path: string, init?: RequestInit) =>
  (await request(path, init)).json() as T;

export const group = {
  name: "Python Web",
  slug: "python-web",
  description: "",
  repositoryIds: [11, 22],
};
export const create = () =>
  request("/api/orgs/acme/groups", { method: "POST", body: JSON.stringify(group) });

/**
 * A completed run of `model` in `scope` (the group's, or a member's), passing the tasks named per
 * repository, on `on` repositories' tasks (every member by default).
 */
export function groupRun(
  scope: { groupId: number } | { repoId: number },
  model: string,
  passed: Record<number, string[]>,
  on: readonly number[] = REPOS.map((repo) => repo.githubId),
): EvaluationRun {
  return {
    id: crypto.randomUUID(),
    ...scope,
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
    trials: REPOS.filter((repo) => on.includes(repo.githubId)).flatMap((repo) =>
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
