import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { OAUTH_STATE_COOKIE } from "../src/api/routes/auth.js";
import { signedIn } from "./support/sign-in.js";
import {
  type AuthServer,
  cookieValue,
  fakeGitHub,
  startAuthServer,
} from "./support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const verifier = randomBytes(32).toString("base64url");
const asked = new URLSearchParams({
  callback: "http://127.0.0.1:4555/callback",
  state: "state-from-the-cli-1234",
  challenge: createHash("sha256").update(verifier).digest("base64url"),
  name: "laptop",
});

test("the CLI signs in through the browser and gets a key only with its PKCE verifier", async () => {
  server = await startAuthServer({ fetchImpl: fakeGitHub().fetch });
  const site = server;

  // Signed out, approval first goes through GitHub sign-in and comes back.
  const signedOut = await site.request(`/auth/cli?${asked}`);
  expect(signedOut.status).toBe(302);
  const next = new URL(signedOut.headers.get("location") ?? "", site.origin);
  expect(next.pathname).toBe("/auth/github");
  const start = await site.request(`${next.pathname}${next.search}`);
  const state = cookieValue(start, OAUTH_STATE_COOKIE) ?? "";
  const returned = await site.request(`/auth/github/callback?code=c&state=${state}`, {
    headers: {
      cookie: start.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; "),
    },
  });
  expect(returned.headers.get("location")).toBe(`/auth/cli?${asked}`);

  const { cookie } = await signedIn(site);
  const page = await site.request(`/auth/cli?${asked}`, { headers: { cookie } });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("laptop");

  // Only a loopback callback, and only an approval from the app's own page.
  const remote = new URLSearchParams({
    ...Object.fromEntries(asked),
    callback: "https://evil.example/cb",
  });
  expect((await site.request(`/auth/cli?${remote}`, { headers: { cookie } })).status).toBe(400);
  const form = { "content-type": "application/x-www-form-urlencoded", cookie };
  const forged = await site.request("/auth/cli", {
    method: "POST",
    headers: { ...form, origin: "https://evil.example" },
    body: asked.toString(),
  });
  expect(forged.status).toBe(403);

  const approved = await site.request("/auth/cli", {
    method: "POST",
    // The fixture's sign-in config has no real public URL, so this approval sends no Origin.
    headers: form,
    body: asked.toString(),
  });
  expect(approved.status).toBe(302);
  const callback = new URL(approved.headers.get("location") ?? "");
  expect(`${callback.origin}${callback.pathname}`).toBe("http://127.0.0.1:4555/callback");
  expect(callback.searchParams.get("state")).toBe("state-from-the-cli-1234");
  const code = callback.searchParams.get("code") ?? "";

  const exchange = (body: object) =>
    site.request("/auth/cli/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await exchange({ code, verifier: randomBytes(32).toString("base64url") })).status).toBe(
    400,
  );
  expect((await exchange({ code: `${code}x`, verifier })).status).toBe(400);
  const issued = await exchange({ code, verifier });
  expect(issued.status).toBe(201);
  const { secret, key, user } = await issued.json();
  expect(user.login).toBeString();
  expect(key).toMatchObject({ name: "CLI on laptop", scope: "write" });

  const bearer = { authorization: `Bearer ${secret}` };
  expect((await site.request("/api/me", { headers: bearer })).status).toBe(200);
  // The key can't approve another CLI, nor revoke other keys, but can revoke itself.
  const viaKey = await site.request(`/auth/cli?${asked}`, { headers: bearer });
  expect(viaKey.status).toBe(302);
  expect(viaKey.headers.get("location")).toStartWith("/auth/github");
  expect(
    (await site.request(`/api/api-keys/${key.id + 1000}`, { method: "DELETE", headers: bearer }))
      .status,
  ).toBe(403);
  expect(
    (await site.request(`/api/api-keys/${key.id}`, { method: "DELETE", headers: bearer })).status,
  ).toBe(200);
  expect((await site.request("/api/me", { headers: bearer })).status).toBe(401);
});
