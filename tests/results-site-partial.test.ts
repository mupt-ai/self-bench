import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResultsSite } from "../src/api/results-site.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import type { ReleaseStore } from "../src/db/releases.js";

/** The results site over a store that cannot be read, as at a start while the database is down. */
let root: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "results-site-partial-"));
  await writeFile(
    join(root, "index.html"),
    '<html><head></head><body><div id="root"></div></body></html>',
  );
  const store = {
    currentLines: async () => {
      throw new Error("database unavailable");
    },
  } as unknown as ReleaseStore;
  const site = createResultsSite({
    siteUrl: "https://selfbench.test",
    appUrl: "https://app.selfbench.test",
    indexable: true,
    root,
    publicRoutes: createPublicReleaseRoutes(store),
  });
  server = createServer(async (request, response) => {
    await site.handle(request, new URL(request.url ?? "/", "http://localhost"), response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test("a home page written without its directory is served, but never cached", async () => {
  const home = await fetch(`${base}/`, { headers: { host: "selfbench.test" } });
  expect(home.status).toBe(200);
  expect(home.headers.get("cache-control")).toBe("no-store");
  const html = await home.text();
  expect(html).toContain("<h1>");
  expect(html).not.toContain("<ul>");
});
