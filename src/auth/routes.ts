import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../api/http.js";
import type { AuthConfig } from "./config.js";
import { clearCookie, parseCookies, sendRedirect, setCookie } from "./cookies.js";
import { constantTimeEqual, randomToken } from "./crypto.js";
import {
  authorizeUrl,
  exchangeCode,
  fetchOrgMemberships,
  fetchProfile,
  GitHubOAuthError,
} from "./github.js";
import { createSessionSigner, SESSION_COOKIE, SESSION_TTL_SECONDS } from "./session.js";
import type { Org, User, UserStore } from "./users.js";

export const OAUTH_STATE_COOKIE = "selfbench_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;

/** Why a sign-in attempt bounced back to /login; the page renders one line per code. */
export type LoginError = "state" | "denied" | "github";

export interface SiteAuthOptions {
  readonly config: AuthConfig;
  readonly users: UserStore;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface SiteAuth {
  /** Answers /auth/* and /api/me. True when the response has been sent. */
  handle(request: IncomingMessage, url: URL, response: ServerResponse): Promise<boolean>;
  /** The signed-in user behind the request's session cookie, if any. */
  authenticate(request: IncomingMessage): Promise<User | undefined>;
}

export function createSiteAuth(options: SiteAuthOptions): SiteAuth {
  const { config, users } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const signer = createSessionSigner(config.sessionSecret, { now });
  const secure = config.publicUrl.startsWith("https://");

  const authenticate = async (request: IncomingMessage): Promise<User | undefined> => {
    const claims = signer.verify(parseCookies(request)[SESSION_COOKIE]);
    return claims ? users.findByGitHubId(claims.githubId) : undefined;
  };

  const startSignIn = (response: ServerResponse): void => {
    const state = randomToken();
    setCookie(response, OAUTH_STATE_COOKIE, state, {
      maxAgeSeconds: STATE_TTL_SECONDS,
      secure,
      path: "/auth",
    });
    sendRedirect(response, authorizeUrl(config, state));
  };

  const finishSignIn = async (
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
  ): Promise<void> => {
    const expected = parseCookies(request)[OAUTH_STATE_COOKIE];
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    clearCookie(response, OAUTH_STATE_COOKIE, { secure, path: "/auth" });
    if (!expected || !state || !constantTimeEqual(expected, state)) {
      sendRedirect(response, loginPath("state"));
      return;
    }
    if (!code) {
      sendRedirect(response, loginPath("denied"));
      return;
    }
    let signedIn: { user: User } | { error: LoginError };
    try {
      const { token, scopes } = await exchangeCode(config, code, fetchImpl);
      const profile = await fetchProfile(config, token, fetchImpl);
      const orgs = await fetchOrgMemberships(config, token, fetchImpl);
      signedIn = { user: await users.upsert({ ...profile, token, scopes, orgs }) };
    } catch (error) {
      if (!(error instanceof GitHubOAuthError)) throw error;
      console.error(`GitHub sign-in failed: ${error.message}`);
      signedIn = { error: "github" };
    }
    if ("error" in signedIn) {
      sendRedirect(response, loginPath(signedIn.error));
      return;
    }
    setCookie(response, SESSION_COOKIE, signer.issue(signedIn.user.githubId), {
      maxAgeSeconds: SESSION_TTL_SECONDS,
      secure,
    });
    sendRedirect(response, "/");
  };

  return {
    authenticate,
    async handle(request, url, response) {
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/auth/github") {
        startSignIn(response);
        return true;
      }
      if (method === "GET" && url.pathname === "/auth/github/callback") {
        await finishSignIn(request, url, response);
        return true;
      }
      if (method === "POST" && url.pathname === "/auth/logout") {
        clearCookie(response, SESSION_COOKIE, { secure });
        sendJson(response, 200, { ok: true });
        return true;
      }
      if (method === "GET" && url.pathname === "/api/me") {
        const user = await authenticate(request);
        if (!user) {
          sendJson(response, 401, { error: "sign in required" });
          return true;
        }
        const orgs = await users.orgsFor(user.id);
        sendJson(response, 200, { user: publicUser(user), orgs: orgs.map(publicOrg) });
        return true;
      }
      return false;
    },
  };
}

/** The browser-facing shape of a user: display fields only. */
export function publicUser(user: User): {
  login: string;
  name?: string;
  avatarUrl?: string;
} {
  return {
    login: user.login,
    ...(user.name ? { name: user.name } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

/** The browser-facing shape of a tenant. */
export function publicOrg(org: Org): {
  login: string;
  kind: "org" | "user";
  role: "admin" | "member";
  name?: string;
  avatarUrl?: string;
} {
  return {
    login: org.login,
    kind: org.kind,
    role: org.role,
    ...(org.name ? { name: org.name } : {}),
    ...(org.avatarUrl ? { avatarUrl: org.avatarUrl } : {}),
  };
}

function loginPath(error: LoginError): string {
  return `/login?error=${error}`;
}
