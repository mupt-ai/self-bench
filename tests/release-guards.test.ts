import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { sendApiError } from "../src/api/http.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import type { ReleaseStore } from "../src/db/releases.js";
import type { EvaluationRun } from "../src/evaluation/types.js";
import { full, names } from "./support/release-fixture.js";
import { releaseServer } from "./support/release-server.js";
import { testDatabase } from "./support/site-fixture.js";

/** Refusals that keep a release honest: stale dialogs, bad ids, and GitHub being down. */
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
  for (const model of ["sol", "terra"]) await server.save(withCredential(full(model, names(1, 3))));
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

test("a withdrawal after the preview is a conflict, not a re-release of what was withdrawn", async () => {
  const settings = await allSettings();
  const first = await (await server.release({ settings })).json();
  const stale = await server.preview();
  await server.releases.withdraw(server.line, first.release.id, "marco");
  const response = await server.release({
    settings,
    head: stale.head.id,
    fingerprint: stale.preview.fingerprint,
  });
  expect(response.status).toBe(409);
  expect((await response.json()).current).toBeNull();
  expect((await server.request("/api/public/repos/vercel/next.js", {}, null)).status).toBe(404);
  // Confirming the refreshed preview releases again, chained to the withdrawn head.
  const again = await server.release({ settings });
  expect(again.status).toBe(201);
});

test("a malformed release id cannot be withdrawn", async () => {
  const response = await server.request(`${server.base}/${"-".repeat(36)}/withdraw`, {
    method: "POST",
  });
  expect(response.status).toBe(404);
});

test("GitHub failing the live check is temporary, not a private repository", async () => {
  server.github.lookupStatus = 403;
  const response = await server.release({ settings: await allSettings() });
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain("Try again");
  expect((await server.request(server.base)).body).toBeDefined();
});

test("a failed public read is not cached", async () => {
  const broken = {
    currentLines: async () => {
      throw new Error("database unavailable");
    },
  } as unknown as ReleaseStore;
  const routes = createPublicReleaseRoutes(broken);
  const failing = createServer(async (request, response) => {
    try {
      await routes.handle(request, new URL(request.url ?? "/", "http://127.0.0.1"), response);
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
  const address = failing.address();
  if (!address || typeof address === "string") throw new Error("No port");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/public/releases`);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control") ?? "no-store").toBe("no-store");
  } finally {
    failing.closeAllConnections();
    await new Promise<void>((resolve) => failing.close(() => resolve()));
  }
});

test("declining a newly eligible setting is recorded, so the next dialog leaves it unticked", async () => {
  const first = await server.release({ settings: await allSettings() });
  expect(first.status).toBe(201);
  // A new setting covers the released tasks, so the next dialog ticks it by default.
  await server.save(withCredential(full("luna", names(1, 3))));
  const view = await server.preview();
  const luna = view.preview.settings.find((setting: { label: string }) => setting.label === "LUNA");
  expect(luna?.ticked).toBe(true);
  // Releasing the same settings without it changes nothing public, but the decline is kept.
  const declined = await server.release({
    settings: view.preview.settings
      .filter((setting: { key: string }) => setting.key !== luna?.key)
      .map((setting: { key: string }) => setting.key),
  });
  expect(declined.status).toBe(201);
  const next = await server.preview();
  expect(
    next.preview.settings.find((setting: { label: string }) => setting.label === "LUNA")?.ticked,
  ).toBe(false);
});

test("with no results site configured, the list offers no public link", async () => {
  const bare = await releaseServer(database, null);
  try {
    expect((await (await bare.request(bare.base)).json()).resultsSiteUrl).toBeNull();
  } finally {
    await bare.close();
  }
});
