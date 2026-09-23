import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendApiError } from "../src/api/http.js";
import { createRateLimiter } from "../src/api/rate-limit.js";
import { createResultsSite } from "../src/api/results-site.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import type { ReleaseStore } from "../src/db/releases.js";
import type { PublishedLine } from "../src/public/release-types.js";

/** The results site over a fake build and a fake store, answering for `selfbench.test`. */
let root: string;
let server: Server;
let base: string;
let reads = 0;
const line = (fullName: string, publisher: string) =>
  ({ release: { repository: { fullName }, publisher: { login: publisher } } }) as PublishedLine;
const store = {
  async currentLines() {
    reads += 1;
    return [line("vercel/next.js", "acme")];
  },
  async currentLinesFor(fullName: string) {
    return fullName.toLowerCase() === "vercel/next.js" ? [line("vercel/next.js", "acme")] : [];
  },
} as unknown as ReleaseStore;

async function start(indexable: boolean, limit = 1_000) {
  const limiter = createRateLimiter({
    perMinute: limit,
    burst: limit,
    globalPerMinute: 100_000,
    globalBurst: 100_000,
  });
  const publicRoutes = createPublicReleaseRoutes(store, { limiter });
  const site = createResultsSite({
    siteUrl: "https://selfbench.test",
    appUrl: "https://app.selfbench.test",
    indexable,
    root,
    releases: store,
    publicRoutes,
    limiter,
  });
  const instance = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (await site.handle(request, url, response)) return;
      response.writeHead(200).end("the app");
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { instance, base: `http://127.0.0.1:${address.port}` };
}

const get = (path: string, init: RequestInit = {}, host = "selfbench.test") =>
  fetch(`${base}${path}`, { ...init, headers: { host, ...init.headers } });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "results-site-"));
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "index.html"),
    "<html><head><title>Self-Bench</title></head><body>shell</body></html>",
  );
  await writeFile(join(root, "assets", "main-abc123.js"), "console.log(1)");
  await writeFile(join(root, "dari-logo.svg"), "<svg/>");
  ({ instance: server, base } = await start(true));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test("only the public host is the public site; every other host is the app's", async () => {
  expect(await (await get("/", {}, "app.selfbench.test")).text()).toBe("the app");
  expect(await (await get("/")).text()).toContain("shell");
  // The same host spelled differently is still the public site, never the app.
  for (const spelled of ["selfbench.test:443", "SelfBench.Test", "selfbench.test."])
    expect((await get("/api/session", {}, spelled)).status).toBe(404);
  expect(await (await get("/", {}, "selfbench.test:8443")).text()).toBe("the app");
});

test("pages get the shell, with the app's address, and a status for crawlers", async () => {
  const home = await get("/");
  expect(home.status).toBe(200);
  const html = await home.text();
  expect(html).toContain('<meta name="selfbench-app-url" content="https://app.selfbench.test" />');
  expect(html).not.toContain("noindex");
  // A dotted repository name is a page, not a missing file.
  expect((await get("/vercel/next.js")).status).toBe(200);
  expect((await get("/VERCEL/Next.js/acme")).status).toBe(200);
  expect((await get("/vercel/next.js/nobody")).status).toBe(404);
  expect((await get("/nobody/nothing")).status).toBe(404);
  expect((await get("/a/b/c/d")).status).toBe(404);
  expect((await get("/%E0%A4%A")).status).toBe(404);
});

test("built files are served, hashed ones cached for good", async () => {
  const script = await get("/assets/main-abc123.js");
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
  expect(script.headers.get("cache-control")).toContain("immutable");
  const logo = await get("/dari-logo.svg");
  expect(logo.headers.get("cache-control")).toBe("public, max-age=3600");
  expect((await get("/../package.json")).status).not.toBe(200);
});

test("the app's surface does not exist on the public host", async () => {
  for (const path of ["/api/session", "/auth/github", "/v1/runs", "/api/orgs/acme/repos"])
    expect((await get(path)).status).toBe(404);
  expect((await get("/", { method: "POST", body: "{}" })).status).toBe(404);
  expect((await get("/api/public/releases")).status).toBe(200);
});

test("robots.txt allows indexing only where the site is indexable", async () => {
  expect(await (await get("/robots.txt")).text()).toBe("User-agent: *\nAllow: /\n");
  const dev = await start(false);
  try {
    const robots = await fetch(`${dev.base}/robots.txt`, { headers: { host: "selfbench.test" } });
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(robots.headers.get("x-robots-tag")).toBe("noindex");
    const page = await fetch(`${dev.base}/`, { headers: { host: "selfbench.test" } });
    expect(await page.text()).toContain('<meta name="robots" content="noindex" />');
  } finally {
    dev.instance.closeAllConnections();
    await new Promise<void>((resolve) => dev.instance.close(() => resolve()));
  }
});

test("a burst of directory reads costs one read of the table", async () => {
  const before = reads;
  await Promise.all(Array.from({ length: 5 }, () => get("/api/public/releases")));
  expect(reads - before).toBeLessThanOrEqual(1);
});

test("a client over its limit is told to wait, and files stay unlimited", async () => {
  const limited = await start(true, 2);
  try {
    const hit = (path: string) =>
      fetch(`${limited.base}${path}`, { headers: { host: "selfbench.test" } });
    expect((await hit("/api/public/releases")).status).toBe(200);
    expect((await hit("/")).status).toBe(200);
    const refused = await hit("/api/public/releases");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await hit("/vercel/next.js")).status).toBe(429);
    expect((await hit("/assets/main-abc123.js")).status).toBe(200);
  } finally {
    limited.instance.closeAllConnections();
    await new Promise<void>((resolve) => limited.instance.close(() => resolve()));
  }
});
