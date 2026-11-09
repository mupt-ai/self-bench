import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { sendApiError } from "../src/api/http.js";
import { createRateLimiter } from "../src/api/rate-limit.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import type { PublishedLine } from "../src/public/release-types.js";

const released = {
  release: {
    schemaVersion: 1,
    releaseId: "next@1",
    releasedAt: "2026-09-10T00:00:00Z",
    repository: { id: 1, fullName: "vercel/next.js" },
    publisher: { login: "acme", kind: "org" },
    tasks: 10,
    settings: [],
    frontier: [],
  },
  endorsed: false,
} as unknown as PublishedLine;

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** The public routes over one release, refusing a caller's seventh request. */
async function serve() {
  const routes = createPublicReleaseRoutes(
    { currentLines: async () => [released] },
    { limiter: createRateLimiter({ perMinute: 1, burst: 6 }) },
  );
  const server = createServer(async (request, response) => {
    try {
      await routes.handle(request, new URL(request.url ?? "/", "http://localhost"), response);
    } catch (error) {
      sendApiError(response, error);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
}

test("a page on any site may read the results, their refusals included, but not a release's tasks", async () => {
  const get = await serve();
  const readable = async (path: string, status: number) => {
    const response = await get(path, { origin: "https://example.com" });
    expect(response.status).toBe(status);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-expose-headers")).toBe("ETag, Retry-After");
    return response;
  };
  const first = await readable("/api/public/results/vercel/next.js", 200);
  const again = await get("/api/public/results/vercel/next.js", {
    "if-none-match": first.headers.get("etag") ?? "",
  });
  expect(again.status).toBe(304);
  expect(again.headers.get("access-control-allow-origin")).toBe("*");
  await readable("/api/public/results", 200);
  await readable("/api/public/results/vercel/withdrawn", 404);
  await readable("/api/public/groups/acme/none", 404);
  // A release's tasks answer, but name no other site.
  const tasks = await get("/api/public/releases/none/tasks");
  expect(tasks.status).toBe(404);
  expect(tasks.headers.get("access-control-allow-origin")).toBeNull();
  // The seventh request is over the limit, and a page can still read why and when to retry.
  const refused = await readable("/api/public/results", 429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
});
