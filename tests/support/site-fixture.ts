import { createServer, type Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { ArtifactStore } from "../../src/artifacts.js";
import type { AuthConfig } from "../../src/auth/config.js";
import { createSiteAuth } from "../../src/auth/routes.js";
import { createUserStore, type UserStore } from "../../src/auth/users.js";
import { loadConfig } from "../../src/config.js";
import { type Database, migrationsFolder } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import { createConnectedRepoRoutes } from "../../src/site/connected-repos.js";
import { createGitHubRepoRoutes } from "../../src/site/github-repos.js";
import { createPullRequestRoutes } from "../../src/site/pr-routes.js";
import { createRepoStore } from "../../src/site/repo-store.js";
import { createRunStore } from "../../src/site/run-store.js";
import type { WorkflowStarter } from "../../src/site/task-start.js";
import type { TaskStatusSource } from "../../src/site/task-status.js";
import { createTaskStore } from "../../src/site/task-store.js";
import { createTaskRoutes } from "../../src/site/tasks.js";

export interface TestDatabase {
  readonly db: Database;
  close(): Promise<void>;
}

/** The site's schema over an in-process PGlite database, so the real SQL runs in tests. */
export async function testDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, close: () => client.close() };
}

export const testAuthConfig: AuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  sessionSecret: "test-session-secret-that-is-long-enough-0123456789",
  publicUrl: "http://127.0.0.1:0",
  databaseUrl: "postgres://unused",
  githubUrl: "https://github.example",
  githubApiUrl: "https://api.github.example",
};

export interface FakeGitHubOptions {
  readonly login?: string;
  readonly orgs?: readonly string[];
  readonly codeAccepted?: boolean;
  /** Repos returned for every repo listing, and the merged-PR count for every search. */
  readonly repos?: readonly { full_name: string; private?: boolean; pushed_at?: string }[];
  readonly mergedPullRequests?: number;
  /** Answers /repos/:owner/:name/pulls/:number; the merge commit's parent is "b" × 40. */
  readonly pullRequests?: Record<number, Record<string, unknown>>;
}

/** A fetch that answers GitHub's OAuth and API endpoints for one signing-in user. */
export function fakeGitHub(options: FakeGitHubOptions = {}): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const login = options.login ?? "avyay";
  const orgs = options.orgs ?? ["Mupt-AI"];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/login/oauth/access_token")) {
      return options.codeAccepted === false
        ? Response.json({ error: "bad_verification_code", error_description: "code is stale" })
        : Response.json({ access_token: "gho_test_token", scope: "read:user,read:org,repo" });
    }
    if (url.endsWith("/user")) {
      return Response.json({ id: 42, login, name: "Avyay", avatar_url: "https://a/x.png" });
    }
    const pull = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(url);
    if (pull?.[1]) {
      const found = options.pullRequests?.[Number(pull[1])];
      return found ? Response.json(found) : new Response("", { status: 404 });
    }
    if (/\/repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]{40}$/.test(url)) {
      return Response.json({ parents: [{ sha: "b".repeat(40) }] });
    }
    const one = /\/repos\/([^/?]+\/[^/?]+)$/.exec(url);
    if (one?.[1]) {
      const index = (options.repos ?? []).findIndex(
        (repo) => repo.full_name.toLowerCase() === one[1]?.toLowerCase(),
      );
      const repo = options.repos?.[index];
      if (!repo) return new Response("", { status: 404 });
      return Response.json({
        id: 5000 + index,
        full_name: repo.full_name,
        name: repo.full_name.split("/")[1],
        private: repo.private ?? false,
        default_branch: "main",
      });
    }
    if (url.includes("/repos?") || url.includes("/user/repos")) {
      return Response.json(
        (options.repos ?? []).map((repo, index) => ({
          id: 5000 + index,
          full_name: repo.full_name,
          name: repo.full_name.split("/")[1],
          private: repo.private ?? false,
          archived: false,
          default_branch: "main",
          language: "TypeScript",
          pushed_at: repo.pushed_at ?? "2026-09-01T00:00:00Z",
        })),
      );
    }
    if (url.includes("/search/issues")) {
      const query = new URL(url);
      if (query.searchParams.get("per_page") === "20") {
        const rows = Object.values(options.pullRequests ?? {})
          .filter((row) => row.merged === true)
          .sort((a, b) => Number(b.number) - Number(a.number));
        const offset = (Number(query.searchParams.get("page")) - 1) * 20;
        return Response.json({
          total_count: rows.length,
          items: rows.slice(offset, offset + 20).map((row) => ({
            ...row,
            pull_request: { merged_at: "2026-09-01T00:00:00Z" },
          })),
        });
      }
      return Response.json({ total_count: options.mergedPullRequests ?? 0 });
    }
    if (url.includes("/user/memberships/orgs")) {
      return Response.json(
        orgs.map((org, index) => ({
          role: index === 0 ? "admin" : "member",
          state: "active",
          organization: { id: 1000 + index, login: org, avatar_url: `https://a/${org}.png` },
        })),
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export interface AuthServer {
  readonly origin: string;
  readonly users: UserStore;
  /** fetch without following redirects, so Location and Set-Cookie can be asserted. */
  request(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

export interface AuthServerOptions {
  readonly config?: AuthConfig;
  readonly fetchImpl?: typeof fetch;
  readonly artifacts?: ArtifactStore;
  readonly start?: WorkflowStarter;
  readonly status?: TaskStatusSource;
}

/** The site's routes over a fresh PGlite database on a real loopback server; other paths 404. */
export async function startAuthServer(options: AuthServerOptions = {}): Promise<AuthServer> {
  const config = options.config ?? testAuthConfig;
  const database = await testDatabase();
  const users = createUserStore(database.db, { secret: config.sessionSecret });
  const repos = createRepoStore(database.db);
  const runs = createRunStore(database.db);
  const tasks = createTaskStore(database.db);
  const fetchImpl = options.fetchImpl ?? fetch;
  const auth = createSiteAuth({ config, users, fetchImpl });
  const github = createGitHubRepoRoutes({ config, users, fetchImpl });
  const connected = createConnectedRepoRoutes({ config, users, repos, fetchImpl });
  const taskRoutes = options.artifacts
    ? createTaskRoutes({
        users,
        repos,
        runs,
        tasks,
        artifacts: options.artifacts,
        ...(options.status ? { status: options.status } : {}),
      })
    : undefined;
  const pullRequestRoutes =
    options.artifacts && options.start
      ? createPullRequestRoutes({
          config: loadConfig({}),
          auth: config,
          users,
          repos,
          tasks,
          artifacts: options.artifacts,
          start: options.start,
          fetchImpl,
        })
      : undefined;
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (await auth.handle(request, url, response)) return;
    if (url.pathname.startsWith("/api/")) {
      const user = await auth.authenticate(request);
      if (!user) {
        response.writeHead(401).end();
        return;
      }
      if (await github.handle(request, url, response, user)) return;
      if (await connected.handle(request, url, response, user)) return;
      if (pullRequestRoutes && (await pullRequestRoutes.handle(request, url, response, user))) {
        return;
      }
      if (taskRoutes && (await taskRoutes.handle(request, url, response, user))) return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    users,
    request: (path, init) => fetch(`${origin}${path}`, { redirect: "manual", ...init }),
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await database.close();
    },
  };
}

/** Pulls `name=value` out of a response's Set-Cookie headers; undefined when not set. */
export function cookieValue(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair?.startsWith(`${name}=`)) return decodeURIComponent(pair.slice(name.length + 1));
  }
  return undefined;
}

export function cookieAttributes(response: Response, name: string): string[] {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) return header.split(";").map((part) => part.trim());
  }
  return [];
}
