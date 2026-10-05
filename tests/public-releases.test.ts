import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { sendApiError } from "../src/api/http.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import { directoryOf } from "../src/public/directory.js";
import type { PublishedLine, ReleaseSetting } from "../src/public/release-types.js";

const setting = (id: string, accuracy: number, costPerTaskUsd: number, onFrontier = true) =>
  ({
    id,
    model: { catalogId: id, name: `openai/${id}`, label: id.toUpperCase() },
    harness: "codex",
    reasoningLevel: "high",
    provider: "openai",
    signIn: "api-key",
    custom: false,
    tasks: 10,
    passed: accuracy / 10,
    accuracy,
    costPerTaskUsd,
    totalCostUsd: costPerTaskUsd * 10,
    onFrontier,
  }) as ReleaseSetting;
/** A setting as a directory card shows it. */
const shown = (id: string, accuracy: number, costPerTaskUsd: number) => ({
  id,
  model: { label: id.toUpperCase() },
  accuracy,
  costPerTaskUsd,
});

const line = (
  fullName: string,
  publisher: string,
  releasedAt: string,
  options: { id?: number; endorsed?: boolean } = {},
): PublishedLine => ({
  release: {
    schemaVersion: 1,
    releaseId: `${fullName}/${publisher}@${releasedAt}`,
    releasedAt,
    repository: {
      id: options.id ?? fullName.length,
      fullName,
      description: "A repository",
      language: "TypeScript",
      defaultBranch: "main",
      stars: 10,
      pushedAt: "2026-09-01T00:00:00Z",
      ownerAvatarUrl: "https://github.com/owner.png",
    },
    publisher: { login: publisher, kind: "org" },
    tasks: 10,
    settings: [setting("sol", 100, 3), setting("luna", 70, 0.4), setting("weak", 50, 5, false)],
    frontier: ["luna", "sol"],
  },
  endorsed: options.endorsed ?? false,
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** The public routes over `read`, on a clock the test moves, counting reads of the table. */
async function serve(read: () => Promise<PublishedLine[]>) {
  let at = 0;
  let reads = 0;
  const routes = createPublicReleaseRoutes(
    {
      currentLines: async () => {
        reads += 1;
        return read();
      },
    },
    { now: () => at },
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
  const base = `http://127.0.0.1:${address.port}`;
  return {
    routes,
    get: (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init),
    advance: (ms: number) => {
      at += ms;
    },
    reads: () => reads,
  };
}

test("the directory is one card per line, holding only what a card and search show", async () => {
  const lines = [
    line("vercel/next.js", "acme", "2026-09-10T00:00:00Z", { id: 1 }),
    line("vercel/next.js", "mupt-ai", "2026-09-12T00:00:00Z", { id: 1 }),
    line("denoland/deno", "acme", "2026-09-11T00:00:00Z", { id: 2 }),
  ];
  const { get } = await serve(async () => lines);
  const response = await get("/api/public/directory");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=10");
  const { cards } = await response.json();
  // Newest release first; each repository's newest line is its default.
  expect(cards.map((card: { publisher: { login: string } }) => card.publisher.login)).toEqual([
    "mupt-ai",
    "acme",
    "acme",
  ]);
  expect(cards.map((card: { defaultLine: boolean }) => card.defaultLine)).toEqual([
    true,
    true,
    false,
  ]);
  expect(cards[0]).toEqual({
    repository: {
      id: 1,
      fullName: "vercel/next.js",
      description: "A repository",
      stars: 10,
      ownerAvatarUrl: "https://github.com/owner.png",
    },
    publisher: { login: "mupt-ai", kind: "org" },
    releaseId: "vercel/next.js/mupt-ai@2026-09-12T00:00:00Z",
    releasedAt: "2026-09-12T00:00:00Z",
    tasks: 10,
    settings: 3,
    picks: [
      { setting: shown("luna", 70, 0.4), roles: ["cheapest"] },
      { setting: shown("sol", 100, 3), roles: ["mostAccurate"] },
    ],
    frontier: [shown("luna", 70, 0.4), shown("sol", 100, 3)],
    others: [shown("weak", 50, 5)],
    endorsed: false,
    defaultLine: true,
  });
});

test("an endorsed line is its repository's default however old", () => {
  const cards = directoryOf([
    line("vercel/next.js", "acme", "2026-09-10T00:00:00Z", { id: 1, endorsed: true }),
    line("vercel/next.js", "mupt-ai", "2026-09-12T00:00:00Z", { id: 1 }),
  ]);
  expect(cards.map((card) => [card.publisher.login, card.defaultLine])).toEqual([
    ["mupt-ai", false],
    ["acme", true],
  ]);
});

test("every public response is tagged; a client holding it gets a bodyless 304", async () => {
  const { get } = await serve(async () => [line("vercel/next.js", "acme", "2026-09-10T00:00:00Z")]);
  for (const path of [
    "/api/public/releases",
    "/api/public/directory",
    "/api/public/repos/Vercel/Next.js",
    "/api/public/results",
    "/api/public/results/Vercel/Next.js",
  ]) {
    const first = await get(path);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[\w-]+"$/);
    const again = await get(path, { headers: { "if-none-match": `W/${etag}, "other"` } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=10");
  }
});

test("the results routes share the directory and repository result payloads", async () => {
  const { get } = await serve(async () => [line("vercel/next.js", "acme", "2026-09-10T00:00:00Z")]);
  for (const [canonical, legacy] of [
    ["/api/public/results", "/api/public/directory"] as const,
    ["/api/public/results/vercel/next.js", "/api/public/repos/vercel/next.js"] as const,
  ]) {
    const [current, alias] = await Promise.all([get(canonical), get(legacy)]);
    expect(current.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(await current.json()).toEqual(await alias.json());
    expect(current.headers.get("etag")).toBe(alias.headers.get("etag"));
  }
});

test("the tag changes only when the content does", async () => {
  let lines = [line("vercel/next.js", "acme", "2026-09-10T00:00:00Z")];
  const { get, advance } = await serve(async () => lines);
  const before = (await get("/api/public/directory")).headers.get("etag");
  advance(10_000);
  expect((await get("/api/public/directory")).headers.get("etag")).toBe(before);
  lines = [...lines, line("denoland/deno", "acme", "2026-09-11T00:00:00Z")];
  advance(10_000);
  expect((await get("/api/public/directory")).headers.get("etag")).not.toBe(before);
});

test("the table is read at most once per few seconds, however many requests arrive", async () => {
  const { get, advance, reads } = await serve(async () => [
    line("vercel/next.js", "acme", "2026-09-10T00:00:00Z"),
  ]);
  await Promise.all(
    [
      "/api/public/releases",
      "/api/public/directory",
      "/api/public/repos/vercel/next.js",
      "/api/public/repos/nobody/nothing",
    ].map((path) => get(path)),
  );
  await get("/api/public/directory");
  expect(reads()).toBe(1);
  advance(5_000);
  await get("/api/public/directory");
  expect(reads()).toBe(2);
});

test("after a release on this server, the next request reads afresh", async () => {
  let lines: PublishedLine[] = [];
  const { get, routes, reads } = await serve(async () => lines);
  expect((await get("/api/public/repos/vercel/next.js")).status).toBe(404);
  lines = [line("vercel/next.js", "acme", "2026-09-10T00:00:00Z")];
  routes.refresh();
  expect((await get("/api/public/repos/vercel/next.js")).status).toBe(200);
  expect(reads()).toBe(2);
});

test("a failed read serves the last good snapshot, and is retried once the interval passes", async () => {
  let failing = false;
  const { get, advance, reads } = await serve(async () => {
    if (failing) throw new Error("database unavailable");
    return [line("vercel/next.js", "acme", "2026-09-10T00:00:00Z")];
  });
  expect((await get("/api/public/directory")).status).toBe(200);
  failing = true;
  advance(5_000);
  expect((await get("/api/public/directory")).status).toBe(200);
  expect((await get("/api/public/repos/vercel/next.js")).status).toBe(200);
  // The failed read is not retried on every request, only once the interval passes again.
  expect(reads()).toBe(2);
  advance(5_000);
  failing = false;
  expect((await get("/api/public/directory")).status).toBe(200);
  expect(reads()).toBe(3);
});

test("an older read that finishes late never replaces a newer one as the fallback", async () => {
  const before = [line("vercel/next.js", "acme", "2026-09-10T00:00:00Z")];
  const after = [...before, line("denoland/deno", "acme", "2026-09-11T00:00:00Z")];
  let finishOld: (lines: PublishedLine[]) => void = () => {};
  let calls = 0;
  const { get, routes, advance } = await serve(() => {
    calls += 1;
    if (calls === 1)
      return new Promise((resolve) => {
        finishOld = resolve;
      });
    if (calls === 2) return Promise.resolve(after);
    return Promise.reject(new Error("database unavailable"));
  });
  // A read from before a release is still in flight when the release asks for a fresh one.
  const slow = get("/api/public/directory");
  await new Promise((resolve) => setTimeout(resolve, 20));
  routes.refresh();
  const cards = async (response: Promise<Response>) => (await (await response).json()).cards.length;
  expect(await cards(get("/api/public/directory"))).toBe(2);
  finishOld(before);
  expect(await cards(slow)).toBe(1);
  // The next read fails: the fallback is the newer snapshot, so the release stays visible.
  advance(5_000);
  expect(await cards(get("/api/public/directory"))).toBe(2);
});

test("paths that are not a public route or a repository are refused, uncached", async () => {
  const { get, reads } = await serve(async () => []);
  for (const path of [
    "/api/public/repos/vercel",
    "/api/public/repos/vercel/next.js/extra",
    "/api/public/repos/vercel/next%20js",
    "/api/public/releases/extra",
    "/api/public/nothing",
  ]) {
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(reads()).toBe(0);
});
