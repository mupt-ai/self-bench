import { afterEach, expect, test } from "bun:test";
import { apiSource } from "./api-source";
import { page } from "./test-fixture";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** Answers the public API from `routes`, recording each requested path. */
function serve(routes: Record<string, { status?: number; lines?: unknown[] }>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    const route = routes[path];
    if (!route) return new Response(null, { status: 404 });
    return Response.json({ lines: route.lines ?? [] }, { status: route.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

const acme = page({ releasedAt: "2026-09-10T00:00:00Z" });
const dari = page({
  releaseId: "dari-release",
  releasedAt: "2026-09-12T00:00:00Z",
  publisher: { login: "mupt-ai", kind: "org" },
});
const line = (from: ReturnType<typeof page>) => ({ release: from.release, endorsed: false });

test("the directory reads every current release once and keeps the newest line per repository", async () => {
  const calls = serve({ "/api/public/releases": { lines: [line(acme), line(dari)] } });
  const cards = await apiSource().listRepos();
  expect(calls).toEqual(["/api/public/releases"]);
  expect(cards).toHaveLength(1);
  expect(cards[0]?.releaseId).toBe("dari-release");
  expect(await apiSource().listLines()).toHaveLength(2);
});

test("a repository page reads only its repository and lists every line", async () => {
  const [owner, name] = acme.release.repository.fullName.split("/") as [string, string];
  const calls = serve({
    [`/api/public/repos/${owner}/${name}`]: { lines: [line(acme), line(dari)] },
  });
  const shown = await apiSource().getLine(owner, name, acme.release.publisher.login);
  expect(calls).toEqual([`/api/public/repos/${owner}/${name}`]);
  expect(shown?.release.releaseId).toBe(acme.release.releaseId);
  expect(shown?.lines.map((entry) => entry.publisher.login)).toEqual([
    "mupt-ai",
    acme.release.publisher.login,
  ]);
});

test("concurrent directory reads share one request; later reads fetch again", async () => {
  const calls = serve({ "/api/public/releases": { lines: [line(acme)] } });
  const source = apiSource();
  await Promise.all([source.listRepos(), source.listLines()]);
  expect(calls).toHaveLength(1);
  await source.listRepos();
  expect(calls).toHaveLength(2);
});

test("nothing released is undefined; a server error is an error", async () => {
  serve({ "/api/public/releases": { status: 503 } });
  expect(await apiSource().getRepo("nobody", "nothing")).toBeUndefined();
  await expect(apiSource().listRepos()).rejects.toThrow("503");
});
