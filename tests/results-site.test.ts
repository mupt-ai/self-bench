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
let outside: string;
let root: string;
let server: Server;
let base: string;
let reads = 0;
const line = (fullName: string, publisher: string, releasedAt: string) =>
  ({
    release: {
      releaseId: `${publisher}@${releasedAt}`,
      releasedAt,
      repository: { fullName },
      publisher: { login: publisher },
      tasks: 12,
      settings: [],
    },
    endorsed: false,
  }) as unknown as PublishedLine;
const store = {
  async currentLines() {
    reads += 1;
    return [
      line("vercel/next.js", "acme", "2026-09-02T00:00:00Z"),
      line("vercel/next.js", "Umbrella", "2026-09-01T00:00:00Z"),
    ];
  },
} as unknown as ReleaseStore;

async function start(indexable: boolean, limit = 1_000) {
  const limiter = createRateLimiter({ perMinute: limit, burst: limit });
  const publicRoutes = createPublicReleaseRoutes(store, { limiter });
  const site = createResultsSite({
    siteUrl: "https://selfbench.test",
    appUrl: "https://app.selfbench.test",
    indexable,
    root,
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
  // The build sits one level down so a file beside it proves traversal stays inside the build.
  outside = await mkdtemp(join(tmpdir(), "results-site-"));
  root = join(outside, "build");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(outside, "secret.txt"), "not part of the build");
  await writeFile(
    join(root, "index.html"),
    '<html><head>\n    <title>Built</title>\n    <meta name="description" content="Built." />\n  </head><body>shell<div id="root"></div></body></html>',
  );
  await writeFile(join(root, "assets", "main-abc123.js"), "console.log(1)");
  await writeFile(join(root, "dari-logo.svg"), "<svg/>");
  await writeFile(join(root, "favicon.ico"), "icon");
  ({ instance: server, base } = await start(true));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(outside, { recursive: true, force: true });
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
  // Paths that cannot name a GitHub repository are refused before any lookup.
  expect((await get("/vercel/next%20js")).status).toBe(404);
  expect((await get(`/${"a".repeat(40)}/next.js`)).status).toBe(404);
});

test("a page that exists may be kept by the CDN a minute, and browsers check it each visit", async () => {
  const home = await get("/");
  expect(home.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60");
  const etag = home.headers.get("etag");
  expect(etag).toMatch(/^"[\w-]+"$/);
  const repository = await get("/vercel/next.js");
  expect(repository.headers.get("etag")).toMatch(/^"[\w-]+"$/);
  // A check with the tag it holds costs a bodyless 304.
  const unchanged = await get("/vercel/next.js", {
    headers: { "if-none-match": repository.headers.get("etag") ?? "" },
  });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  expect(unchanged.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60");
});

/** The tags of `html` that match `pattern`, by their first group. */
const all = (html: string, pattern: RegExp) =>
  [...html.matchAll(new RegExp(pattern, "g"))].map((match) => match[1]);

test("each page has its own title, description and address, in place of the build's", async () => {
  const home = await (await get("/")).text();
  expect(all(home, /<title>([^<]*)<\/title>/)).toEqual([
    "SelfBench: Benchmark Coding Agents on Your Own Repository",
  ]);
  expect(all(home, /<meta name="description" content="([^"]*)"/)).toHaveLength(1);
  expect(home).not.toContain("Built");
  expect(home).toContain('<link rel="canonical" href="https://selfbench.test/" />');
  expect(home).toContain(
    '<meta property="og:image" content="https://selfbench.test/icon-192.png" />',
  );
  const [data] = all(home, /<script type="application\/ld\+json">([^<]*)<\/script>/);
  expect(JSON.parse(data ?? "")["@graph"][0]).toMatchObject({
    "@type": "WebSite",
    name: "SelfBench",
  });

  const repository = await (await get("/VERCEL/Next.js")).text();
  expect(all(repository, /<title>([^<]*)<\/title>/)).toEqual([
    "vercel/next.js: Coding Agent Benchmark · SelfBench",
  ]);
  expect(repository).toContain("12 tasks from its merged pull requests");
  // One page whatever the casing, at the repository's own; its default line is the same page.
  expect(repository).toContain(
    '<link rel="canonical" href="https://selfbench.test/vercel/next.js" />',
  );
  expect(await (await get("/vercel/next.js/ACME")).text()).toContain(
    '<link rel="canonical" href="https://selfbench.test/vercel/next.js" />',
  );
  expect(await (await get("/vercel/next.js/umbrella")).text()).toContain(
    '<link rel="canonical" href="https://selfbench.test/vercel/next.js/Umbrella" />',
  );
  expect(repository).toContain('"@type":"Dataset"');

  const missing = await (await get("/nobody/nothing")).text();
  expect(all(missing, /<title>([^<]*)<\/title>/)).toEqual([
    "nobody/nothing: Coding Agent Benchmark · SelfBench",
  ]);
  expect(missing).not.toContain("canonical");
});

test("the sitemap lists every page the site can show, from the released lines", async () => {
  const sitemap = await get("/sitemap.xml");
  expect(sitemap.status).toBe(200);
  expect(sitemap.headers.get("content-type")).toContain("application/xml");
  expect(sitemap.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60");
  expect(all(await sitemap.text(), /<loc>([^<]*)<\/loc>/)).toEqual([
    "https://selfbench.test/",
    "https://selfbench.test/vercel/next.js",
    "https://selfbench.test/vercel/next.js/Umbrella",
  ]);
});

test("a page that does not exist is never cached, so a first release shows at once", async () => {
  const missing = await get("/nobody/nothing");
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  expect(missing.headers.get("etag")).toBeNull();
  expect(await missing.text()).toContain("shell");
  // Even a tag from a page that did exist gets the page, not a 304.
  const etag = (await get("/")).headers.get("etag") ?? "";
  expect((await get("/nobody/nothing", { headers: { "if-none-match": etag } })).status).toBe(404);
});

test("built files are served, hashed ones cached for good", async () => {
  const script = await get("/assets/main-abc123.js");
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
  expect(script.headers.get("cache-control")).toContain("immutable");
  const logo = await get("/dari-logo.svg");
  expect(logo.headers.get("cache-control")).toBe("public, max-age=3600");
  const icon = await get("/favicon.ico");
  expect(icon.headers.get("content-type")).toBe("image/x-icon");
  // An encoded slash survives URL parsing, so the server itself must refuse to leave the build.
  const escaped = await get("/..%2fsecret.txt");
  expect(escaped.status).toBe(404);
  expect(await escaped.text()).not.toContain("not part of the build");
});

test("the app's surface does not exist on the public host", async () => {
  for (const path of ["/api/session", "/auth/github", "/v1/runs", "/api/orgs/acme/repos"])
    expect((await get(path)).status).toBe(404);
  expect((await get("/", { method: "POST", body: "{}" })).status).toBe(404);
  expect((await get("/api/public/releases")).status).toBe(200);
});

test("robots.txt allows indexing only where the site is indexable", async () => {
  expect(await (await get("/robots.txt")).text()).toBe(
    "User-agent: *\nAllow: /\n\nSitemap: https://selfbench.test/sitemap.xml\n",
  );
  const dev = await start(false);
  try {
    const robots = await fetch(`${dev.base}/robots.txt`, { headers: { host: "selfbench.test" } });
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(robots.headers.get("x-robots-tag")).toBe("noindex");
    const page = await fetch(`${dev.base}/`, { headers: { host: "selfbench.test" } });
    expect(await page.text()).toContain('<meta name="robots" content="noindex" />');
    // A site search engines may not index has no sitemap to offer them.
    const sitemap = await fetch(`${dev.base}/sitemap.xml`, { headers: { host: "selfbench.test" } });
    expect(sitemap.status).toBe(404);
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

test("a repository page's preview is its release's card, which the site draws as a PNG", async () => {
  const page = await (await get("/vercel/next.js")).text();
  expect(page).toContain(
    '<meta property="og:image" content="https://selfbench.test/og/vercel/next.js.png?v=acme%402026-09-02T00%3A00%3A00Z" />',
  );
  expect(page).toContain('<meta name="twitter:card" content="summary_large_image" />');
  // Another publisher's line has its own card.
  expect(await (await get("/vercel/next.js/umbrella")).text()).toContain(
    "https://selfbench.test/og/vercel/next.js/Umbrella.png?v=",
  );

  const image = await get("/og/vercel/next.js.png");
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("cache-control")).toBe("public, max-age=3600, s-maxage=86400");
  const bytes = new Uint8Array(await image.arrayBuffer());
  expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect((await get("/og/vercel/next.js/umbrella.png")).status).toBe(200);
  expect((await get("/og/nobody/nothing.png")).status).toBe(404);
});

test("each page's text is in its root before any script runs, with one heading", async () => {
  for (const path of ["/", "/vercel/next.js", "/vercel/next.js/umbrella", "/nobody/nothing"]) {
    const html = await (await get(path)).text();
    const root = html.slice(html.indexOf('<div id="root">'));
    expect(root).toStartWith('<div id="root"><main class="page-text"');
    expect(html.split("<h1").length - 1).toBe(1);
  }
});
