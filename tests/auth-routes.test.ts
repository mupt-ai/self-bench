import { afterEach, describe, expect, test } from "bun:test";
import { loadAuthConfig } from "../src/auth/config.js";
import { authorizeUrl } from "../src/auth/github.js";
import { OAUTH_STATE_COOKIE } from "../src/auth/routes.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import {
  type AuthServer,
  cookieAttributes,
  cookieValue,
  type FakeGitHubOptions,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
} from "./support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function boot(github: FakeGitHubOptions = {}, config = testAuthConfig) {
  const hub = fakeGitHub(github);
  server = await startAuthServer({ config, fetchImpl: hub.fetch });
  return { server, users: server.users, hub };
}

/** Walks /auth/github then the callback with the state GitHub would echo back. */
async function signIn(site: AuthServer, override?: { state?: string; code?: string }) {
  const start = await site.request("/auth/github");
  const state = cookieValue(start, OAUTH_STATE_COOKIE) ?? "";
  const params = new URLSearchParams({
    code: override?.code ?? "code-123",
    state: override?.state ?? state,
  });
  return site.request(`/auth/github/callback?${params}`, {
    headers: { cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}` },
  });
}

describe("OAuth start", () => {
  test("redirects to GitHub with the requested scopes and a state bound to a cookie", async () => {
    const { server: site } = await boot();
    const response = await site.request("/auth/github");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://github.example");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("scope")).toBe("read:user read:org repo");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:0/auth/github/callback",
    );
    const state = cookieValue(response, OAUTH_STATE_COOKIE);
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(location.searchParams.get("state")).toBe(state ?? "");
    expect(cookieAttributes(response, OAUTH_STATE_COOKIE)).toEqual(
      expect.arrayContaining(["Path=/auth", "HttpOnly", "SameSite=Lax", "Max-Age=600"]),
    );
    expect(authorizeUrl({ ...testAuthConfig, publicUrl: "https://selfbench.dev" }, "s")).toContain(
      "redirect_uri=https%3A%2F%2Fselfbench.dev%2Fauth%2Fgithub%2Fcallback",
    );
  });
});

describe("OAuth callback state check", () => {
  test("a matching state signs the user in and clears the state cookie", async () => {
    const { server: site, users, hub } = await boot();
    const response = await signIn(site);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const session = cookieValue(response, SESSION_COOKIE);
    expect(session).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cookieAttributes(response, SESSION_COOKIE)).toEqual(
      expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${30 * 86400}`]),
    );
    expect(cookieAttributes(response, SESSION_COOKIE)).not.toContain("Secure");
    expect(cookieAttributes(response, OAUTH_STATE_COOKIE)).toContain("Max-Age=0");
    expect(await users.findByGitHubId(42)).toMatchObject({ login: "avyay", name: "Avyay" });
    expect(await users.gitHubToken(42)).toBe("gho_test_token");
    expect(hub.calls[0]).toBe("POST https://github.example/login/oauth/access_token");
    expect(hub.calls[1]).toBe("GET https://api.github.example/user");
    expect(hub.calls[2]).toBe(
      "GET https://api.github.example/user/memberships/orgs?state=active&per_page=100&page=1",
    );
    expect(await users.orgsFor(1)).toEqual([
      expect.objectContaining({
        githubId: 42,
        login: "avyay",
        kind: "user",
        name: "Avyay",
        avatarUrl: "https://a/x.png",
        role: "admin",
      }),
      expect.objectContaining({
        githubId: 1000,
        login: "Mupt-AI",
        kind: "org",
        avatarUrl: "https://a/Mupt-AI.png",
        role: "admin",
      }),
    ]);
  });

  test("a mismatched or missing state never reaches GitHub", async () => {
    const { server: site, users, hub } = await boot();
    const mismatched = await signIn(site, { state: "forged-state" });
    expect(mismatched.status).toBe(302);
    expect(mismatched.headers.get("location")).toBe("/login?error=state");
    expect(cookieValue(mismatched, SESSION_COOKIE)).toBeUndefined();

    const noCookie = await site.request("/auth/github/callback?code=c&state=s");
    expect(noCookie.headers.get("location")).toBe("/login?error=state");

    expect(hub.calls).toEqual([]);
    expect(await users.findByGitHubId(42)).toBeUndefined();
  });

  test("GitHub denials and stale codes bounce back with a reason", async () => {
    const { server: site } = await boot({ codeAccepted: false });
    const denied = await signIn(site, { code: "" });
    expect(denied.headers.get("location")).toBe("/login?error=denied");
    const stale = await signIn(site);
    expect(stale.headers.get("location")).toBe("/login?error=github");
    expect(cookieValue(stale, SESSION_COOKIE)).toBeUndefined();
  });

  test("uses Secure cookies behind an https public URL", async () => {
    const { server: site } = await boot(
      {},
      { ...testAuthConfig, publicUrl: "https://selfbench.dev" },
    );
    const response = await signIn(site);
    expect(cookieAttributes(response, SESSION_COOKIE)).toContain("Secure");
  });
});

describe("org memberships", () => {
  test("a user with no orgs still signs in with only a personal tenant", async () => {
    const { server: site, users } = await boot({ orgs: [] });
    const response = await signIn(site);
    expect(response.headers.get("location")).toBe("/");
    expect((await users.orgsFor(1)).map((org) => org.kind)).toEqual(["user"]);
  });
});

describe("/api/me and logout", () => {
  test("answers 401 without a valid session and the display fields with one", async () => {
    const { server: site } = await boot();
    expect((await site.request("/api/me")).status).toBe(401);
    const signedIn = await signIn(site);
    const session = cookieValue(signedIn, SESSION_COOKIE) ?? "";
    const me = await site.request("/api/me", {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: { login: "avyay", name: "Avyay", avatarUrl: "https://a/x.png" },
      orgs: [
        {
          login: "avyay",
          kind: "user",
          role: "admin",
          name: "Avyay",
          avatarUrl: "https://a/x.png",
        },
        { login: "Mupt-AI", kind: "org", role: "admin", avatarUrl: "https://a/Mupt-AI.png" },
      ],
    });
    const tampered = await site.request("/api/me", {
      headers: { cookie: `${SESSION_COOKIE}=${session.slice(0, -2)}xx` },
    });
    expect(tampered.status).toBe(401);
  });

  test("logout clears the cookie and refuses non-POST", async () => {
    const { server: site } = await boot();
    const response = await site.request("/auth/logout", { method: "POST" });
    expect(response.status).toBe(200);
    expect(cookieAttributes(response, SESSION_COOKIE)).toContain("Max-Age=0");
    expect((await site.request("/auth/logout")).status).toBe(404);
  });
});

describe("auth config", () => {
  test("is off without a client id and complete otherwise", () => {
    expect(loadAuthConfig({})).toBeUndefined();
    const base = {
      GITHUB_OAUTH_CLIENT_ID: "id",
      GITHUB_OAUTH_CLIENT_SECRET: "secret",
      SELFBENCH_SESSION_SECRET: "x".repeat(32),
      SELFBENCH_PUBLIC_URL: "https://selfbench.dev/",
      SELFBENCH_DATABASE_URL: "postgres://localhost/selfbench",
    };
    expect(loadAuthConfig(base)).toMatchObject({
      publicUrl: "https://selfbench.dev",
      githubUrl: "https://github.com",
    });
    expect(() => loadAuthConfig({ ...base, SELFBENCH_SESSION_SECRET: "short" })).toThrow(
      "SELFBENCH_SESSION_SECRET",
    );
    expect(() => loadAuthConfig({ ...base, GITHUB_OAUTH_CLIENT_SECRET: "" })).toThrow(
      "GITHUB_OAUTH_CLIENT_SECRET",
    );
    expect(() => loadAuthConfig({ ...base, SELFBENCH_PUBLIC_URL: "" })).toThrow(
      "SELFBENCH_PUBLIC_URL",
    );
  });
});
