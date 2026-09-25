import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createSessionSigner, SESSION_COOKIE } from "../../src/api/auth/session.js";
import { sendApiError } from "../../src/api/http.js";
import { createSiteAuth } from "../../src/api/routes/auth.js";
import { createPublicReleaseRoutes } from "../../src/api/routes/public-releases.js";
import { createReleaseRoutes } from "../../src/api/routes/releases.js";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { createApiKeyStore } from "../../src/db/api-keys.js";
import { createReleaseStore } from "../../src/db/releases.js";
import { createRepoStore } from "../../src/db/repos.js";
import { credentials } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { createUserStore } from "../../src/db/users.js";
import { saveEvaluation } from "../../src/evaluation/store.js";
import type { EvaluationRun } from "../../src/evaluation/types.js";
import { full, names } from "./release-fixture.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "./site-fixture.js";

/** What the fake GitHub reports for the connected repository; tests change it. */
interface FakeRepository {
  private: boolean;
  stars: number;
  fullName: string;
  gone?: boolean;
  /** When set, the repository lookup answers with this status and no body. */
  lookupStatus?: number;
  /** Runs while a release looks the repository up, to interleave another request. */
  onLookup?: () => Promise<void>;
}

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
      sql`truncate table releases, tasks, credentials, api_keys, repos, org_members, orgs, users restart identity cascade`,
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
  const github: FakeRepository = { private: false, stars: 137842, fullName: "vercel/next.js" };
  const ids: Record<string, number> = { priya: 1, marco: 2, outsider: 3 };
  const githubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const login = new Headers(init?.headers).get("authorization")?.replace("Bearer token-", "");
    if (url === `${testAuthConfig.githubApiUrl}/user`)
      return Response.json({ id: ids[login ?? ""] ?? 0 });
    if (url === `${testAuthConfig.githubApiUrl}/repositories/70107786` && github.onLookup)
      await github.onLookup();
    if (url === `${testAuthConfig.githubApiUrl}/repositories/70107786` && github.lookupStatus)
      return new Response(null, { status: github.lookupStatus });
    if (url === `${testAuthConfig.githubApiUrl}/repositories/70107786` && !github.gone)
      return Response.json({
        id: 70107786,
        full_name: github.fullName,
        private: github.private,
        archived: false,
        description: "The React Framework",
        language: "JavaScript",
        default_branch: "canary",
        stargazers_count: github.stars,
        pushed_at: "2026-09-22T03:14:55Z",
        owner: { avatar_url: "https://avatars.example/vercel.png" },
      });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
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
      if (!(await routes.handle(request, url, response, user))) response.writeHead(404).end();
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  publicUrl = `http://127.0.0.1:${address.port}`;
  const routes = createReleaseRoutes({
    db: database.db,
    artifacts,
    users,
    repos,
    releases,
    publicUrl,
    githubApiUrl: testAuthConfig.githubApiUrl,
    resultsSiteUrl,
    fetchImpl: githubFetch,
  });
  const publicRoutes = createPublicReleaseRoutes(releases);
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
    /** Approves tasks `names` of generation run "gen" on the connected repository. */
    async approve(names: readonly string[]) {
      await tasks.upsertMany(
        names.map((name) => ({
          repoId: repo.id,
          runId: "gen",
          candidateId: `candidate-${name}`,
          taskId: name,
          pipelineStatus: "accepted" as const,
          stage: "accepted",
          difficulty: "medium" as const,
          bundleKey: `tasks/${name}.tar.gz`,
        })),
      );
      for (const name of names) {
        const task = await tasks.find(repo.id, "gen", name);
        if (task) await tasks.review(task.id, { decision: "approve", note: "", userId: priya.id });
      }
    },
    /** Saves `run` on the connected repository, evaluated with the workspace's credential. */
    async save(run: EvaluationRun) {
      await saveEvaluation(artifacts, {
        ...run,
        repoId: repo.id,
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
