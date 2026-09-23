import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { EvaluationRun } from "../src/evaluation/types.js";
import { full, names } from "./support/release-fixture.js";
import { releaseServer } from "./support/release-server.js";
import { testDatabase } from "./support/site-fixture.js";

let database: Awaited<ReturnType<typeof testDatabase>>;
let server: Awaited<ReturnType<typeof releaseServer>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  server = await releaseServer(database);
  await server.approve(names(1, 3));
  for (const model of ["sol", "terra", "luna"])
    await server.save(withCredential(full(model, names(1, 3))));
});
afterEach(async () => {
  await server.close();
});

const withCredential = (run: EvaluationRun): EvaluationRun => ({
  ...run,
  credentials: {
    modelCredentialId: server.credentialId,
    sandboxCredentialId: "s",
    provider: "openai",
  },
});
const allSettings = async () =>
  (await server.preview()).preview.settings.map((setting: { key: string }) => setting.key);

test("release routes need a session and membership; the public routes need neither", async () => {
  expect((await server.request(`${server.base}/preview`, {}, null)).status).toBe(401);
  expect((await server.request(`${server.base}/preview`, {}, 3)).status).toBe(404);
  expect((await server.request("/api/public/releases", {}, null)).status).toBe(200);
  const missing = await server.request("/api/public/repos/vercel/next.js", {}, null);
  expect(missing.status).toBe(404);
  // A miss is never cached, so the first release shows up at once.
  expect(missing.headers.get("cache-control")).toBe("no-store");
  expect(
    (await server.request("/api/public/releases", { method: "POST", body: "{}" }, null)).status,
  ).toBe(405);
});

test("a first release is published, and the public API serves only its payload", async () => {
  const preview = await server.preview();
  expect(preview.head).toBeNull();
  expect(preview.preview.settings.every((setting: { ticked: boolean }) => !setting.ticked)).toBe(
    true,
  );
  const response = await server.release({ settings: await allSettings() });
  expect(response.status).toBe(201);
  const { release } = await response.json();
  expect(release).toMatchObject({ releasedBy: "priya", tasks: 3, settings: 3, current: true });

  const listed = await (await server.request("/api/public/releases", {}, null)).json();
  expect(listed.lines).toHaveLength(1);
  const served = listed.lines[0].release;
  expect(served).toMatchObject({
    releaseId: release.id,
    tasks: 3,
    repository: { id: 70107786, fullName: "vercel/next.js", stars: 137842 },
    publisher: { login: "acme", kind: "org" },
  });
  const text = JSON.stringify(listed);
  for (const hidden of [
    "priya",
    "gen",
    "candidate",
    "token",
    "hash",
    "detail",
    server.credentialId,
  ])
    expect(text).not.toContain(hidden);
  const page = await server.request("/api/public/repos/VERCEL/Next.js", {}, null);
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("public, max-age=60");
});

test("releasing the same results again writes no row", async () => {
  const settings = await allSettings();
  expect((await server.release({ settings })).status).toBe(201);
  server.github.stars += 10;
  const again = await server.release({ settings });
  expect(again.status).toBe(200);
  expect((await again.json()).unchanged).toBe(true);
  const list = await (await server.request(server.base)).json();
  expect(list.releases).toHaveLength(1);
  expect(list.resultsSiteUrl).toBe("https://selfbench.example");
});

test("a withdrawal during a release is not mistaken for unchanged results", async () => {
  const settings = await allSettings();
  const first = await (await server.release({ settings })).json();
  // A teammate withdraws the current release while this identical release is in flight.
  server.github.onLookup = async () => {
    delete server.github.onLookup;
    await server.releases.withdraw(server.line, first.release.id, "marco");
  };
  const response = await server.release({ settings });
  expect(response.status).toBe(201);
  const page = await server.request("/api/public/repos/vercel/next.js", {}, null);
  expect(page.status).toBe(200);
});

test("a stale head or changed results answer 409 with a fresh preview", async () => {
  const settings = await allSettings();
  const stale = await server.preview();
  expect((await server.release({ settings }, 2)).status).toBe(201);
  const race = await server.release({
    settings,
    head: stale.head?.id ?? null,
    fingerprint: stale.preview.fingerprint,
  });
  expect(race.status).toBe(409);
  const body = await race.json();
  expect(body.error).toContain("marco released");
  expect(body.head.releasedBy).toBe("marco");

  const before = await server.preview();
  await server.save(withCredential(full("sol", ["t1"], { createdAt: "2026-09-03T00:00:00Z" })));
  const changed = await server.release({
    settings,
    head: before.head.id,
    fingerprint: before.preview.fingerprint,
  });
  expect(changed.status).toBe(409);
  expect((await changed.json()).error).toContain("changed since you opened this");
});

test("stars changing between preview and release is not a mismatch", async () => {
  const view = await server.preview();
  server.github.stars = 1;
  const response = await server.request(server.base, {
    method: "POST",
    body: JSON.stringify({
      settings: await allSettings(),
      head: null,
      fingerprint: view.preview.fingerprint,
    }),
  });
  expect(response.status).toBe(201);
});

test("two first releases at once: exactly one wins", async () => {
  const settings = await allSettings();
  const view = await server.preview();
  const body = JSON.stringify({ settings, head: null, fingerprint: view.preview.fingerprint });
  const results = await Promise.all([
    server.request(server.base, { method: "POST", body }),
    server.request(server.base, { method: "POST", body }, 2),
  ]);
  const statuses = results.map((result) => result.status).sort();
  // The loser either sees the winner as head (409) or, if it read after the insert, the
  // identical results (200, no row). Never two rows.
  expect(statuses[0]).toBe(201);
  expect([200, 409]).toContain(statuses[1] ?? 0);
  expect((await (await server.request(server.base)).json()).releases).toHaveLength(1);
});

test("a repository that turned private or vanished cannot be released", async () => {
  const settings = await allSettings();
  server.github.private = true;
  const refused = await server.release({ settings });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain("public repositories");
  server.github.private = false;
  server.github.gone = true;
  expect((await server.release({ settings })).status).toBe(400);
});

test("empty and disjoint selections are refused", async () => {
  expect((await server.release({ settings: [] })).status).toBe(400);
  await server.approve(["t4"]);
  await server.save(withCredential(full("only-four", ["t4"])));
  const settings = await allSettings();
  const refused = await server.release({ settings });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain("no approved task in common");
});

test("withdrawing falls back to the previous release; the next release chains to the head", async () => {
  const first = await (await server.release({ settings: await allSettings() })).json();
  await server.approve(["t4"]);
  for (const model of ["sol", "terra"]) await server.save(withCredential(full(model, ["t4"])));
  const defaults = await server.preview();
  expect(
    defaults.preview.settings.filter((setting: { ticked: boolean }) => setting.ticked),
  ).toHaveLength(3);
  const second = await (
    await server.release({
      settings: defaults.preview.settings
        .filter((setting: { label: string }) => setting.label !== "LUNA")
        .map((setting: { key: string }) => setting.key),
    })
  ).json();
  expect(second.release.tasks).toBe(4);
  let page = await (await server.request("/api/public/repos/vercel/next.js", {}, null)).json();
  expect(page.lines[0].release.releaseId).toBe(second.release.id);

  const withdrawn = await server.request(`${server.base}/${second.release.id}/withdraw`, {
    method: "POST",
  });
  expect(withdrawn.status).toBe(200);
  page = await (await server.request("/api/public/repos/vercel/next.js", {}, null)).json();
  expect(page.lines[0].release.releaseId).toBe(first.release.id);
  const view = await server.preview();
  expect(view.head.id).toBe(second.release.id);
  expect(view.current.id).toBe(first.release.id);
  // Defaults come from the current release again: LUNA is no longer declined.
  expect(
    view.preview.settings.filter((setting: { ticked: boolean }) => setting.ticked),
  ).toHaveLength(3);
  // The same settings as the current release publish nothing new.
  expect((await server.release()).status).toBe(200);
  // Without LUNA again: a new row, chained to the withdrawn head.
  const third = await server.release({
    settings: view.preview.settings
      .filter((setting: { label: string }) => setting.label !== "LUNA")
      .map((setting: { key: string }) => setting.key),
  });
  expect(third.status).toBe(201);
  const list = (await (await server.request(server.base)).json()).releases;
  expect(list.map((row: { id: string }) => row.id).slice(1)).toEqual([
    second.release.id,
    first.release.id,
  ]);
  expect(
    (await server.request(`${server.base}/${second.release.id}/withdraw`, { method: "POST" }))
      .status,
  ).toBe(404);
});

test("a declined setting stays unticked next time", async () => {
  const settings = await allSettings();
  await server.release({ settings: settings.slice(0, 2) });
  const view = await server.preview();
  expect(
    view.preview.settings.filter((setting: { ticked: boolean }) => setting.ticked),
  ).toHaveLength(2);
});

test("disconnecting keeps the release public; a reconnect starts from nothing", async () => {
  expect((await server.release({ settings: await allSettings() })).status).toBe(201);
  await server.disconnect();
  expect((await server.request("/api/public/repos/vercel/next.js", {}, null)).status).toBe(200);
  expect((await server.request(`${server.base}/preview`)).status).toBe(404);
  await server.reconnect();
  const view = await server.preview();
  expect(view.preview.settings).toEqual([]);
  expect(view.current).not.toBeNull();
  const refused = await server.release({ settings: [] });
  expect(refused.status).toBe(400);
});

test("mutations need the site's own origin", async () => {
  const response = await server.request(server.base, {
    method: "POST",
    body: "{}",
    headers: { origin: "https://evil.example" },
  });
  expect(response.status).toBe(403);
});
