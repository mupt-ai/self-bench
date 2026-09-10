import { expect, test } from "bun:test";
import { createCodexLogins } from "../src/evaluation/codex-login.js";
import { listCredentials } from "../src/evaluation/credentials.js";
import { orgRecords } from "../src/evaluation/org-records.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { MemoryRecords } from "./support/evaluation-records.js";

const auth = JSON.stringify({
  tokens: { access_token: "test-access-never-return", refresh_token: "test-refresh-never-return" },
});
function loginFixture(lifetime?: number) {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  let closed = 0;
  const logins = createCodexLogins(
    async () => ({
      instructions: Promise.resolve({
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "TEST-CODE",
      }),
      auth: new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
      close: async () => {
        closed++;
      },
    }),
    lifetime,
  );
  return {
    logins,
    resolve: (value = auth) => resolve(value),
    reject: () => reject(new Error("Sign-in expired")),
    closed: () => closed,
  };
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("device sign-in saves once, keeps secrets out of status, and enforces ceremony ownership", async () => {
  const fixture = loginFixture();
  const records = new MemoryRecords();
  try {
    const pending = await fixture.logins.start(4, 7, " Team Codex ");
    await settle();
    expect(fixture.logins.status(4, 7, pending.id).status).toBe("waiting");
    expect(() => fixture.logins.status(4, 8, pending.id)).toThrow("expired");
    expect(() => fixture.logins.status(5, 7, pending.id)).toThrow("expired");
    await expect(fixture.logins.cancel(5, 7, pending.id)).rejects.toThrow("expired");
    await expect(fixture.logins.complete(4, 7, pending.id, records)).rejects.toThrow(
      "Finish signing in",
    );
    fixture.resolve();
    await settle();
    expect(fixture.closed()).toBe(1);
    const ready = fixture.logins.status(4, 7, pending.id);
    expect(ready.status).toBe("ready");
    expect(JSON.stringify(ready)).not.toContain("test-access");
    const saved = await Promise.all([
      fixture.logins.complete(4, 7, pending.id, records),
      fixture.logins.complete(4, 7, pending.id, records),
    ]);
    expect(saved[0]?.id).toBe(saved[1]?.id);
    expect(saved[0]?.name).toBe("Team Codex");
    expect(JSON.stringify(saved)).not.toContain("test-refresh");
    expect((await fixture.logins.complete(4, 7, pending.id, records)).id).toBe(saved[0]?.id);
    expect(await listCredentials(orgRecords(records, 4), 4)).toHaveLength(1);
    expect(await listCredentials(orgRecords(records, 5), 5)).toHaveLength(0);
  } finally {
    await fixture.logins.close();
  }
});

test("failed saves can retry without signing in again", async () => {
  const fixture = loginFixture();
  class FlakyRecords extends MemoryRecords {
    fail = true;
    override async write(path: string, value: unknown, version: number) {
      if (this.fail) {
        this.fail = false;
        throw new Error("Storage offline");
      }
      return super.write(path, value, version);
    }
  }
  const records = new FlakyRecords();
  try {
    const pending = await fixture.logins.start(4, 7, "Codex");
    await settle();
    fixture.resolve();
    await settle();
    await expect(fixture.logins.complete(4, 7, pending.id, records)).rejects.toThrow(
      "saving failed",
    );
    expect(fixture.logins.status(4, 7, pending.id).status).toBe("ready");
    await fixture.logins.complete(4, 7, pending.id, records);
    expect(await listCredentials(orgRecords(records, 4), 4)).toHaveLength(1);
  } finally {
    await fixture.logins.close();
  }
});

test("cancellation and expiry discard sign-ins; invalid credentials never become ready", async () => {
  const fixture = loginFixture();
  try {
    const pending = await fixture.logins.start(4, 7, "Codex");
    await settle();
    await fixture.logins.cancel(4, 7, pending.id);
    fixture.resolve();
    await settle();
    expect(() => fixture.logins.status(4, 7, pending.id)).toThrow("expired");
    const invalid = await fixture.logins.start(4, 7, "Codex");
    await settle();
    fixture.resolve('{"OPENAI_API_KEY":"do-not-accept"}');
    await settle();
    expect(fixture.logins.status(4, 7, invalid.id).status).toBe("failed");
  } finally {
    await fixture.logins.close();
  }
  const expiring = loginFixture(20);
  const pending = await expiring.logins.start(4, 7, "Codex");
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(() => expiring.logins.status(4, 7, pending.id)).toThrow("expired");
  expect(expiring.closed()).toBe(1);
  await expiring.logins.close();
});

test("HTTP sign-in requires admin, same origin and current user; completion exposes only saved metadata", async () => {
  const fixture = loginFixture();
  const records = new MemoryRecords();
  const site = await evaluationServer(records, fixture.logins);
  const base = "/api/orgs/avyay/credentials/codex-login";
  const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    expect((await site.request(base, post({ name: "Codex" }), null)).status).toBe(401);
    expect((await site.request(base, post({ name: "Codex" }), 2)).status).toBe(404);
    expect(
      (
        await site.request(base, {
          ...post({ name: "Codex" }),
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await site.request(base, post({ name: "" }))).status).toBe(400);
    const team = { githubId: 20, login: "team", role: "member" as const };
    await site.users.upsert({
      githubId: 2,
      login: "outsider",
      token: "other-secret",
      scopes: "repo",
      orgs: [team],
    });
    expect(
      (await site.request("/api/orgs/team/credentials/codex-login", post({ name: "Codex" }), 2))
        .status,
    ).toBe(403);
    const start = await site.request(base, post({ name: "Team Codex" }));
    expect(start.status).toBe(202);
    const pending = await start.json();
    await settle();
    fixture.resolve();
    await settle();
    const ready = await site.request(`${base}/${pending.id}`);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect((await ready.json()).status).toBe("ready");
    expect((await site.request(`${base}/${pending.id}/complete`)).status).toBe(405);
    const complete = await site.request(`${base}/${pending.id}/complete`, post({}));
    expect(complete.status).toBe(200);
    expect(await complete.text()).not.toContain("test-access");
    const list = await (await site.request("/api/orgs/avyay/credentials")).json();
    expect(list.credentials).toHaveLength(1);
    expect(list.credentials[0].auth).toBe("codex-login");
    expect((await site.request(`${base}/${pending.id}/cancel`, post({}))).status).toBe(200);
    expect((await site.request(`${base}/${pending.id}`)).status).toBe(410);
  } finally {
    await fixture.logins.close();
    await site.close();
  }
});
