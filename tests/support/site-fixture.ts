import { createServer, type Server } from "node:http";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { AuthConfig } from "../../src/auth/config.js";
import { createSiteAuth, type SiteAuthOptions } from "../../src/auth/routes.js";
import { migrate } from "../../src/db/migrations.js";
import type { SqlClient } from "../../src/db/sql.js";

/** The site's SqlClient over an in-process PGlite database, so the real SQL runs in tests. */
export async function pgliteClient(): Promise<SqlClient> {
  const db = new PGlite();
  await db.waitReady;
  const bind = (executor: PGlite | Transaction): SqlClient => ({
    async query<Row>(text: string, params: readonly unknown[] = []): Promise<Row[]> {
      const result = await executor.query<Row>(text, [...params]);
      return result.rows;
    },
    async exec(text) {
      await executor.exec(text);
    },
    transaction: (work) =>
      (executor as PGlite).transaction((tx) => work(bind(tx))) as Promise<never>,
    close: () => db.close(),
  });
  return bind(db);
}

export async function migratedClient(): Promise<SqlClient> {
  const sql = await pgliteClient();
  await migrate(sql);
  return sql;
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
  /** fetch without following redirects, so Location and Set-Cookie can be asserted. */
  request(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

/** Runs the site's auth routes on a real loopback server; other paths answer 404. */
export async function startAuthServer(options: SiteAuthOptions): Promise<AuthServer> {
  const auth = createSiteAuth(options);
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (await auth.handle(request, url, response)) return;
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    request: (path, init) => fetch(`${origin}${path}`, { redirect: "manual", ...init }),
    stop: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
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
