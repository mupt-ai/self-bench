import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createSessionSigner, SESSION_COOKIE } from "../../src/api/auth/session.js";
import { sendApiError } from "../../src/api/http.js";
import { createSiteAuth } from "../../src/api/routes/auth.js";
import { createGroupReleaseRoutes } from "../../src/api/routes/group-releases.js";
import { createPublicReleaseRoutes } from "../../src/api/routes/public-releases.js";
import { createReleaseRoutes, type PublicChange } from "../../src/api/routes/releases.js";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { createApiKeyStore } from "../../src/db/api-keys.js";
import { createGroupReleaseStore } from "../../src/db/group-releases.js";
import { createReleaseStore } from "../../src/db/releases.js";
import { createRepoGroupStore } from "../../src/db/repo-groups.js";
import { type ConnectedRepo, createRepoStore } from "../../src/db/repos.js";
import { credentials } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { createUserStore } from "../../src/db/users.js";
import { saveEvaluation } from "../../src/evaluation/store.js";
import type { EvaluationRun } from "../../src/evaluation/types.js";
import { full, names } from "./release-fixture.js";
import { fakeGitHub } from "./release-github.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "./site-fixture.js";
import { taskBundle } from "./tar.js";

/**
 * The release routes and the public routes over PGlite, a local artifact store, and a fake
 * GitHub. Two members of workspace `acme` (priya, marco) and one outsider. A `shared`
 * database is emptied and reused: each PGlite instance keeps its memory, so one per test
 * file, not one per test.
 */
export async function releaseServer(
  shared?: TestDatabase,
  resultsSiteUrl: string | null = "https://selfbench.example",
) {
  const directory = await mkdtemp(join(tmpdir(), "release-routes-"));
  const artifacts = new LocalArtifactStore(directory);
  const database = shared ?? (await testDatabase());
  if (shared)
    await shared.db.execute(
      sql`truncate table releases, group_releases, group_evaluations, repo_groups, tasks, credentials, api_keys, repos, org_members, orgs, users restart identity cascade`,
    );
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
  const marco = await member(2, "marco", ["acme"]);
  await member(3, "outsider", []);
  const tenant = (await users.orgsFor(priya.id)).find((org) => org.login === "acme");
  if (!tenant) throw new Error("missing acme workspace");
  const repos = createRepoStore(database.db);
  const connect = () =>
    repos.connect({
      orgId: tenant.id,
      githubId: 70107786,
      fullName: "vercel/next.js",
      defaultBranch: "canary",
      private: false,
      connectedBy: priya.id,
    });
  let repo = await connect();
  const tasks = createTaskStore(database.db);
  const releases = createReleaseStore(database.db);
  await database.db.insert(credentials).values([
    {
      id: crypto.randomUUID(),
      orgId: tenant.id,
      name: "OpenAI",
      kind: "openai",
      auth: "api-key",
    },
  ]);
  const [credential] = await database.db.select().from(credentials);
  if (!credential) throw new Error("missing credential");
  const { github, commerceOnGitHub, githubFetch } = fakeGitHub();
  const auth = createSiteAuth({
    config: testAuthConfig,
    users,
    apiKeys: createApiKeyStore(database.db),
    fetchImpl: githubFetch,
  });
  let publicUrl = "";
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", publicUrl);
      if (await publicRoutes.handle(request, url, response)) return;
      const user = await auth.authenticate(request);
      if (!user) {
        response.writeHead(401).end();
        return;
      }
      if (
        !(await routes.handle(request, url, response, user)) &&
        !(await groupRoutes.handle(request, url, response, user))
      )
        response.writeHead(404).end();
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  publicUrl = `http://127.0.0.1:${address.port}`;
  const groupReleases = createGroupReleaseStore(database.db);
  const groups = createRepoGroupStore(database.db);
  const publicRoutes = createPublicReleaseRoutes(releases, { artifacts, groupReleases });
  /** The slugs each group release and withdrawal reported changing, in order. */
  const groupChanges: string[] = [];
  const options = {
    db: database.db,
    artifacts,
    users,
    repos,
    publicUrl,
    githubApiUrl: testAuthConfig.githubApiUrl,
    resultsSiteUrl,
    fetchImpl: githubFetch,
  };
  const groupRoutes = createGroupReleaseRoutes({
    ...options,
    groups,
    releases: groupReleases,
    onPublicChange: ({ slug }) => {
      groupChanges.push(slug);
      publicRoutes.refresh();
    },
  });
  /** What each release and withdrawal reported changing, in order. */
  const changes: PublicChange[] = [];
  const routes = createReleaseRoutes({
    ...options,
    releases,
    onPublicChange: (change) => {
      changes.push(change);
      publicRoutes.refresh();
    },
  });
  const signer = createSessionSigner(testAuthConfig.sessionSecret);
  const base = "/api/orgs/acme/repos/vercel/next.js/releases";
  const request = (path: string, init: RequestInit = {}, githubId: number | null = 1) =>
    fetch(`${publicUrl}${path}`, {
      ...init,
      headers: {
        origin: publicUrl,
        "content-type": "application/json",
        ...(githubId === null ? {} : { cookie: `${SESSION_COOKIE}=${signer.issue(githubId)}` }),
        ...init.headers,
      },
    });
  return {
    db: database.db,
    changes,
    tasks,
    releases,
    github,
    marco,
    get repo() {
      return repo;
    },
    credentialId: credential.id,
    line: { orgId: tenant.id, githubRepoId: 70107786 },
    base,
    request,
    groups,
    groupReleases,
    groupChanges,
    commerceOnGitHub,
    tenant,
    /** Connects vercel/commerce too (GitHub id 4242), for a group of the two. */
    connectCommerce: () =>
      repos.connect({
        orgId: tenant.id,
        githubId: 4242,
        fullName: "vercel/commerce",
        defaultBranch: "main",
        private: false,
        connectedBy: priya.id,
      }),
    /** Approves tasks `names` of generation run `runId` on a connected repository. */
    async approve(names: readonly string[], on: ConnectedRepo = repo, runId = "gen") {
      await tasks.upsertMany(
        names.map((name) => ({
          repoId: on.id,
          runId,
          candidateId: `candidate-${name}`,
          taskId: name,
          pipelineStatus: "accepted" as const,
          stage: "accepted",
          difficulty: "medium" as const,
          bundleKey: `tasks/${name}.tar.gz`,
        })),
      );
      // Each task's compiled bundle, which a release that publishes its tasks serves.
      for (const name of names)
        await artifacts.put(`tasks/${name}.tar.gz`, await taskBundle(name), "application/gzip");
      for (const name of names) {
        const task = await tasks.find(on.id, runId, name);
        if (task) await tasks.review(task.id, { decision: "approve", note: "", userId: priya.id });
      }
    },
    /** Saves `run` on a connected repository, evaluated with the workspace's credential. */
    async save(run: EvaluationRun, on: ConnectedRepo = repo) {
      await saveEvaluation(artifacts, {
        ...run,
        repoId: on.id,
        credentials: {
          modelCredentialId: credential.id,
          sandboxCredentialId: "s",
          provider: "openai",
        },
      });
    },
    async preview(githubId = 1) {
      return (await request(`${base}/preview`, {}, githubId)).json();
    },
    /** Every setting key the preview lists, ticked or not. */
    async allSettings(): Promise<string[]> {
      return (await this.preview()).preview.settings.map((setting: { key: string }) => setting.key);
    },
    /** Releases with the preview's defaults, or `settings` when given. */
    async release(
      body: { settings?: string[]; head?: string | null; fingerprint?: string } = {},
      githubId = 1,
    ) {
      const view = await (await request(`${base}/preview`, {}, githubId)).json();
      const settings =
        body.settings ??
        view.preview.settings
          .filter((s: { ticked: boolean }) => s.ticked)
          .map((s: { key: string }) => s.key);
      return request(
        base,
        {
          method: "POST",
          body: JSON.stringify({
            settings,
            head: body.head === undefined ? (view.head?.id ?? null) : body.head,
            fingerprint: body.fingerprint ?? view.preview.fingerprint,
          }),
        },
        githubId,
      );
    },
    async disconnect() {
      await repos.disconnect(tenant.id, "vercel/next.js");
    },
    async reconnect() {
      repo = await connect();
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!shared) await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export type ReleaseServer = Awaited<ReturnType<typeof releaseServer>>;

/**
 * One shared database per test file and a fresh release server per test, with tasks t1-t3
 * approved and a full run of each of `models` saved.
 */
export function releaseServerPerTest(models: readonly string[]) {
  let database: TestDatabase;
  let server: ReleaseServer;
  beforeAll(async () => {
    database = await testDatabase();
  });
  afterAll(async () => {
    await database.close();
  });
  beforeEach(async () => {
    server = await releaseServer(database);
    await server.approve(names(1, 3));
    for (const model of models) await server.save(full(model, names(1, 3)));
  });
  afterEach(async () => {
    await server.close();
  });
  return {
    get database() {
      return database;
    },
    get server() {
      return server;
    },
  };
}
