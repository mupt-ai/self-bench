import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApiKeyStore } from "../src/db/api-keys.js";
import { apiKeys } from "../src/db/schema.js";
import { createUserStore } from "../src/db/users.js";
import { mint } from "./support/api-keys.js";
import { signedIn } from "./support/sign-in.js";
import {
  type AuthServer,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
  testDatabase,
} from "./support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe("api key store", () => {
  test("mints an unguessable secret, stores only its hash, and resolves it to the owner", async () => {
    const database = await testDatabase();
    try {
      const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
      const user = await users.upsert({
        githubId: 7,
        login: "owner",
        token: "gho",
        scopes: "",
        orgs: [],
      });
      const clock = new Date("2026-09-14T10:00:00Z");
      const store = createApiKeyStore(database.db, { now: () => clock });
      const { key, secret } = await store.create(user.id, { name: "CI", scope: "write" });
      expect(secret.startsWith("sbk_")).toBe(true);
      expect(secret.length).toBeGreaterThan(40);
      expect(key).toEqual({
        id: key.id,
        name: "CI",
        prefix: secret.slice(0, 12),
        scope: "write",
        createdAt: "2026-09-14T10:00:00.000Z",
      });
      const [row] = await database.db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
      // Issued keys stay valid only while the stored digest is a plain SHA-256 of the secret.
      expect(row?.keyHash).toBe(createHash("sha256").update(secret).digest("hex"));
      expect(JSON.stringify(row)).not.toContain(secret);

      const resolved = await store.authenticate(secret);
      expect(resolved).toEqual({
        id: user.id,
        githubId: 7,
        login: "owner",
        apiKey: { id: key.id, name: "CI", scope: "write" },
      });
      expect((await store.list(user.id))[0]?.lastUsedAt).toBe("2026-09-14T10:00:00.000Z");
      expect(await store.authenticate("sbk_not-a-real-key")).toBeUndefined();
      expect(await store.authenticate("gho")).toBeUndefined();

      expect(await store.revoke(user.id + 1, key.id)).toBe(false);
      expect(await store.revoke(user.id, key.id)).toBe(true);
      expect(await store.revoke(user.id, key.id)).toBe(false);
      expect(await store.authenticate(secret)).toBeUndefined();
      expect(await store.list(user.id)).toEqual([]);
    } finally {
      await database.close();
    }
  });
});

describe("api key routes", () => {
  test("keys are created from a browser session, shown once, and revoked", async () => {
    server = await startAuthServer({ fetchImpl: fakeGitHub().fetch });
    const headers = await signedIn(server);
    const crossSite = await server.request("/api/api-keys", {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: JSON.stringify({ name: "CI" }),
    });
    expect(crossSite.status).toBe(403);
    const invalid = await server.request("/api/api-keys", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "", scope: "admin" }),
    });
    expect(invalid.status).toBe(400);

    const { key, secret } = await mint(server, headers, { name: "CI" });
    expect(key.scope).toBe("write");
    const listed = await server.request("/api/api-keys", { headers });
    const list = (await listed.json()) as { keys: { id: number; prefix: string }[] };
    expect(list.keys.map((entry) => entry.id)).toEqual([key.id]);
    expect(JSON.stringify(list)).not.toContain(secret);

    const fromKey = await server.request("/api/api-keys", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "escalated" }),
    });
    expect(fromKey.status).toBe(403);

    // The browser revokes with a body-less DELETE: same-origin cookie, no content type.
    const { cookie, origin } = headers;
    const revoke = () =>
      server?.request(`/api/api-keys/${key.id}`, { method: "DELETE", headers: { cookie, origin } });
    expect((await revoke())?.status).toBe(200);
    expect((await revoke())?.status).toBe(404);
    expect((await (await server.request("/api/api-keys", { headers })).json()).keys).toEqual([]);
  });

  test("a key authenticates /api routes through either header; missing, bogus and revoked keys are refused", async () => {
    server = await startAuthServer({
      fetchImpl: fakeGitHub({ orgs: ["Mupt-AI"], repos: [{ full_name: "Mupt-AI/self-bench" }] })
        .fetch,
    });
    const headers = await signedIn(server);
    const { key, secret } = await mint(server, headers, { name: "CI", scope: "write" });

    expect((await server.request("/api/me")).status).toBe(401);
    const bogus = await server.request("/api/me", { headers: { "x-api-key": "sbk_nope" } });
    expect(bogus.status).toBe(401);
    expect(await bogus.json()).toEqual({ error: "invalid API key", code: "invalid_api_key" });

    const bearer = await server.request("/api/me", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toMatchObject({
      auth: "api-key",
      apiKey: { name: "CI", scope: "write" },
      user: { login: "avyay" },
    });
    const explicit = await server.request("/api/me", { headers: { "x-api-key": secret } });
    expect(explicit.status).toBe(200);

    const keyHeaders = { "x-api-key": secret };
    const connected = await server.request("/api/orgs/mupt-ai/repos", {
      method: "POST",
      headers: keyHeaders,
      body: JSON.stringify({ fullName: "mupt-ai/self-bench" }),
    });
    expect(connected.status).toBe(201);
    const one = await server.request("/api/orgs/mupt-ai/repos/Mupt-AI/self-bench", {
      headers: keyHeaders,
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ repo: { fullName: "Mupt-AI/self-bench" } });
    expect(
      (await server.request("/api/orgs/mupt-ai/repos/Mupt-AI/other", { headers: keyHeaders }))
        .status,
    ).toBe(404);

    expect(
      (await server.request(`/api/api-keys/${key.id}`, { method: "DELETE", headers })).status,
    ).toBe(200);
    const revoked = await server.request("/api/orgs/mupt-ai/repos", { headers: keyHeaders });
    expect(revoked.status).toBe(401);
  });
});
