import { beforeEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { sendApiError } from "../src/api/http.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import type { ReleaseStore } from "../src/db/releases.js";
import { full, names } from "./support/release-fixture.js";
import {
  type ReleaseServer,
  releaseServer,
  releaseServerPerTest,
} from "./support/release-server.js";

/** Refusals that keep a release honest: stale dialogs, bad ids, and GitHub being down. */
const suite = releaseServerPerTest(["sol", "terra"]);
let server: ReleaseServer;
beforeEach(() => {
  server = suite.server;
});

test("a withdrawal after the preview is a conflict, not a re-release of what was withdrawn", async () => {
  const settings = await server.allSettings();
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
  const response = await server.release({ settings: await server.allSettings() });
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain("Try again");
  // Nothing was released, and the release list still answers.
  const list = await server.request(server.base);
  expect(list.status).toBe(200);
  expect(await server.releases.list(server.line)).toEqual([]);
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
  const first = await server.release({ settings: await server.allSettings() });
  expect(first.status).toBe(201);
  // A new setting covers the released tasks, so the next dialog ticks it by default.
  await server.save(full("luna", names(1, 3)));
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
  const bare = await releaseServer(suite.database, null);
  try {
    expect((await (await bare.request(bare.base)).json()).resultsSiteUrl).toBeNull();
  } finally {
    await bare.close();
  }
});
