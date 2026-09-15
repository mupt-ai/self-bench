import { expect } from "bun:test";
import { OAUTH_STATE_COOKIE } from "../../src/auth/routes.js";
import { SESSION_COOKIE } from "../../src/auth/session.js";
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

export async function mint(site: AuthServer, headers: Record<string, string>, body: object) {
  const response = await site.request("/api/api-keys", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    key: { id: number; name: string; prefix: string; scope: string; createdAt: string };
    secret: string;
  };
}
