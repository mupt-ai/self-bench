import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIndexNow, INDEXNOW_KEY, INDEXNOW_KEY_PATH } from "../src/api/indexnow.js";
import { createResultsSite } from "../src/api/results-site.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import type { ReleaseStore } from "../src/db/releases.js";

/** A stand-in for the IndexNow endpoint: every notification, and how it answers. */
function endpoint(answer: () => Response | Promise<Response>) {
  const sent: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return answer();
  }) as typeof fetch;
  return { sent, fetchImpl };
}

test("a change tells the engines which of the site's pages changed, with the site's key", async () => {
  const { sent, fetchImpl } = endpoint(() => new Response(null, { status: 202 }));
  const logged: string[] = [];
  const indexNow = createIndexNow({
    siteUrl: "https://selfbench.test",
    fetchImpl,
    delayMs: 0,
    log: (message) => logged.push(message),
  });
  await indexNow.changed(["/", "/vercel/next.js", "/vercel/next.js/acme"]);
  expect(sent).toEqual([
    {
      url: "https://api.indexnow.org/indexnow",
      body: {
        host: "selfbench.test",
        key: INDEXNOW_KEY,
        keyLocation: `https://selfbench.test${INDEXNOW_KEY_PATH}`,
        urlList: [
          "https://selfbench.test/",
          "https://selfbench.test/vercel/next.js",
          "https://selfbench.test/vercel/next.js/acme",
        ],
      },
    },
  ]);
  // Accepted while the key is checked is not a failure.
  expect(logged).toEqual([]);
});

test("a notification that fails is logged and dropped, never thrown", async () => {
  const logged: string[] = [];
  const log = (message: string) => logged.push(message);
  const down = endpoint(() => Promise.reject(new Error("connection refused")));
  await createIndexNow({
    siteUrl: "https://selfbench.test",
    fetchImpl: down.fetchImpl,
    delayMs: 0,
    log,
  }).changed(["/"]);
  const refused = endpoint(() => new Response(null, { status: 403 }));
  await createIndexNow({
    siteUrl: "https://selfbench.test",
    fetchImpl: refused.fetchImpl,
    delayMs: 0,
    log,
  }).changed(["/"]);
  expect(logged).toEqual([
    "IndexNow notification failed: connection refused",
    "IndexNow refused a notification: 403",
  ]);
});

let root: string;
const servers: Server[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "indexnow-"));
  await writeFile(
    join(root, "index.html"),
    '<html><head></head><body><div id="root"></div></body></html>',
  );
});
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(root, { recursive: true, force: true });
});

/** The results site, indexable or not, answering for selfbench.test. */
async function site(indexable: boolean) {
  const store = { currentLines: async () => [] } as unknown as ReleaseStore;
  const results = createResultsSite({
    siteUrl: "https://selfbench.test",
    appUrl: "https://app.selfbench.test",
    indexable,
    root,
    publicRoutes: createPublicReleaseRoutes(store),
  });
  const server = createServer(async (request, response) => {
    await results.handle(request, new URL(request.url ?? "/", "http://localhost"), response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return (path: string) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { host: "selfbench.test" } });
}

test("only a site search engines may index serves the key", async () => {
  const prod = await site(true);
  const key = await prod(INDEXNOW_KEY_PATH);
  expect(key.status).toBe(200);
  expect(await key.text()).toBe(INDEXNOW_KEY);
  expect((await (await site(false))(INDEXNOW_KEY_PATH)).status).toBe(404);
});
