import { SESSION_COOKIE } from "../../src/api/auth/session.js";
import { OAUTH_STATE_COOKIE } from "../../src/api/routes/auth.js";
import { type AuthServer, cookieValue } from "./site-fixture.js";

/** Signs in through the OAuth flow and returns cookie headers that pass the same-origin check. */
export async function signedIn(site: AuthServer) {
  const start = await site.request("/auth/github");
  const state = cookieValue(start, OAUTH_STATE_COOKIE) ?? "";
  const callback = await site.request(`/auth/github/callback?code=c&state=${state}`, {
    headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  });
  const cookie = `${SESSION_COOKIE}=${cookieValue(callback, SESSION_COOKIE) ?? ""}`;
  return { cookie, origin: site.origin, "content-type": "application/json" };
}

/** Connects a repository to the signed-in user's Mupt-AI workspace. */
export function connectRepo(
  site: AuthServer,
  headers: Record<string, string>,
  fullName = "Mupt-AI/self-bench",
): Promise<Response> {
  return site.request("/api/orgs/mupt-ai/repos", {
    method: "POST",
    headers,
    body: JSON.stringify({ fullName }),
  });
}
