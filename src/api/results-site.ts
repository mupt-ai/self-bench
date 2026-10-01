import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { repositoryPath, segmentsOf } from "../public/paths.js";
import type { PublishedRelease } from "../public/release-types.js";
import { contentType, escapeAttribute, sendJson } from "./http.js";
import { INDEXNOW_KEY_PATH, sendIndexNowKey } from "./indexnow.js";
import { cardPng } from "./link-card.js";
import { clientIp, type RateLimiter } from "./rate-limit.js";
import type { PublicReleaseRoutes } from "./routes/public-releases.js";
import { headTags, lineAt, type PageHead, sitemapOf } from "./site-head.js";
import { sitePages } from "./site-pages.js";
import { sendTagged, type TaggedBody, tagged } from "./tagged.js";

export interface ResultsSiteOptions {
  /** Where selfbench.dev lives; requests for its host are this site's, all others the app's. */
  siteUrl: string;
  /** The app's origin, for the site's Sign In links. */
  appUrl: string;
  /** Whether search engines may index the site: true for prod, false for dev. */
  indexable: boolean;
  /** The built public site, `dist/public-site`. */
  root: string;
  /** The public API, whose snapshot of released lines also decides each page's status. */
  publicRoutes: PublicReleaseRoutes;
  limiter?: RateLimiter;
  /** Tags added to every page's head: the telemetry config (`telemetry-meta.ts`). */
  head?: string;
}

/**
 * A host as a browser means it: lower case, without the scheme's default port or a trailing dot.
 * `selfbench.dev:443` and `SelfBench.dev.` are the same site as `selfbench.dev`.
 */
function sameHost(protocol: string): (value: string | undefined) => string | undefined {
  const defaultPort = protocol === "https:" ? "443" : "80";
  return (value) => {
    if (!value) return undefined;
    try {
      const { hostname, port } = new URL(`${protocol}//${value}`);
      const name = hostname.replace(/\.$/, "");
      return port && port !== defaultPort ? `${name}:${port}` : name;
    } catch {
      return undefined;
    }
  };
}

/**
 * A page that exists is the same for everyone. The CDN may keep it 10 seconds, so a release
 * shows within about 15 (the API servers re-read releases every 5), and it is cleared on every
 * deploy, because the page names that build's scripts. Browsers check it on every visit, a
 * bodyless 304 while it is unchanged. With `s-maxage` the CDN never hands out an expired copy,
 * neither while it refreshes one nor while the API is down, so no page is ever older than that;
 * a `stale-while-revalidate` would change nothing.
 */
const PAGE_CACHE = "public, max-age=0, s-maxage=10";
/**
 * A link preview image stays the same for its release (its address carries the release id), so
 * the CDN may keep it a day; browsers an hour, in case one is fetched without the id.
 */
const CARD_CACHE = "public, max-age=3600, s-maxage=86400";
/** How many preview images are kept drawn, by release: each takes a few tens of milliseconds. */
const CARDS_KEPT = 100;
const HTML_TYPE = "text/html; charset=utf-8";

/** The build's own title and description, which each page's head replaces. */
const BUILT_HEAD = [/\n?[ \t]*<title>[^<]*<\/title>/, /\n?[ \t]*<meta name="description"[^>]*>/];
/** The build's empty root, which holds each page's text until the site's script replaces it. */
const BUILT_ROOT = /<div id="root"([^>]*)>\s*<\/div>/;

/**
 * The public results site, served by the same API process on its own host. On that host only
 * the public site answers: its API, its files, and its pages. Sign-in, the app's API, and every
 * write answer 404, so the public host is never a second way into the app.
 */
export function createResultsSite(options: ResultsSiteOptions) {
  const site = new URL(options.siteUrl);
  const normalize = sameHost(site.protocol);
  const host = normalize(site.host);
  const root = resolve(options.root);
  const origin = site.origin;
  let shell: Promise<string> | undefined;
  /** The built page with the tags every page shares; `</head>` is left for the page's own. */
  const built = () => {
    shell ??= readFile(resolve(root, "index.html"), "utf8").then((html) =>
      BUILT_HEAD.reduce((rest, tag) => rest.replace(tag, ""), html).replace(
        "</head>",
        `    <meta name="selfbench-app-url" content="${escapeAttribute(options.appUrl)}" />\n${
          options.indexable ? "" : '    <meta name="robots" content="noindex" />\n'
        }${options.head ? `    ${options.head}\n` : ""}</head>`,
      ),
    );
    shell.catch(() => {
      shell = undefined;
    });
    return shell;
  };
  // Replaced by functions, so a `$` in the text (a price, a model's name) is never a pattern.
  const page = async (head: PageHead, body: string, data = "") =>
    tagged(
      (await built())
        .replace("</head>", () => `${headTags(head, origin)}  </head>`)
        .replace(
          BUILT_ROOT,
          (_, attributes: string) => `<div id="root"${attributes}>${body}</div>${data}`,
        ),
    );
  /** Preview images already drawn, by release id, oldest first. */
  const cards = new Map<string, Buffer>();
  const cardFor = (release: PublishedRelease) => {
    let png = cards.get(release.releaseId);
    if (!png) {
      png = cardPng(release);
      cards.set(release.releaseId, png);
      for (const key of cards.keys()) {
        if (cards.size <= CARDS_KEPT) break;
        cards.delete(key);
      }
    }
    return png;
  };
  /** A built file for this path, or undefined; never outside the build, never the shell. */
  const file = async (pathname: string) => {
    if (pathname === "/" || pathname.endsWith("/") || pathname === "/index.html") return undefined;
    const path = resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!path.startsWith(`${root}${sep}`)) return undefined;
    return readFile(path).then(
      (body) => ({ path, body }),
      () => undefined,
    );
  };
  const pageOf = sitePages(origin, options.publicRoutes);

  return {
    /** Answers every request for the public host; false when the request is the app's. */
    async handle(request: IncomingMessage, url: URL, response: ServerResponse): Promise<boolean> {
      if (normalize(request.headers.host) !== host) return false;
      if (!options.indexable) response.setHeader("x-robots-tag", "noindex");
      if (await options.publicRoutes.handle(request, url, response)) return true;
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 404, { error: "not found" });
        return true;
      }
      if (/^\/(api|auth|v1)(\/|$)/.test(url.pathname)) {
        sendJson(response, 404, { error: "not found" });
        return true;
      }
      if (options.indexable && url.pathname === INDEXNOW_KEY_PATH) {
        sendIndexNowKey(response);
        return true;
      }
      if (url.pathname === "/robots.txt") {
        const body = options.indexable
          ? `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`
          : "User-agent: *\nDisallow: /\n";
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600",
        });
        response.end(body);
        return true;
      }
      // A repository's link preview image: /og/<owner>/<name>.png, or …/<name>/<publisher>.png.
      const card = /^\/og\/(.+)\.png$/.exec(url.pathname);
      if (card) {
        const path = repositoryPath(segmentsOf(card[1] ?? ""));
        const lines = path
          ? await options.publicRoutes.linesFor(`${path.owner}/${path.name}`).catch(() => [])
          : [];
        const release = path ? lineAt(lines, path.publisher)?.release : undefined;
        if (!release) {
          sendJson(response, 404, { error: "not found" });
          return true;
        }
        // Drawing costs CPU, so a new image counts against the client's limit; a kept one does not.
        const verdict = cards.has(release.releaseId)
          ? { ok: true as const }
          : (options.limiter?.take(clientIp(request)) ?? { ok: true as const });
        if (!verdict.ok) {
          response.setHeader("cache-control", "no-store");
          response.setHeader("retry-after", String(verdict.retryAfter));
          sendJson(response, 429, { error: "Too many requests; try again shortly" });
          return true;
        }
        const png = cardFor(release);
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": png.byteLength,
          "cache-control": CARD_CACHE,
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : png);
        return true;
      }
      const found = await file(url.pathname).catch(() => undefined);
      if (found) {
        response.writeHead(200, {
          "content-type": contentType(found.path),
          "content-length": found.body.byteLength,
          // Only files under /assets/ carry a content hash in their name.
          "cache-control": url.pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "public, max-age=3600",
          "x-content-type-options": "nosniff",
        });
        response.end(found.body);
        return true;
      }
      // A page: the site's shell, with the page's own title, description and address, and its
      // text for readers that run no scripts. Its status says whether the repository has anything
      // released, which is what crawlers and link previews see; the page itself renders in the
      // browser.
      const verdict = options.limiter?.take(clientIp(request)) ?? { ok: true };
      if (!verdict.ok) {
        response.setHeader("cache-control", "no-store");
        response.setHeader("retry-after", String(verdict.retryAfter));
        sendJson(response, 429, { error: "Too many requests; try again shortly" });
        return true;
      }
      // Every page the site can show, read from the released lines like the pages themselves, so
      // it lists a release as soon as its page shows it. Kept by the CDN as briefly as pages are.
      if (url.pathname === "/sitemap.xml" && options.indexable) {
        const repositories = await options.publicRoutes.repositories().catch(() => undefined);
        if (!repositories) {
          response.setHeader("cache-control", "no-store");
          sendJson(response, 503, { error: "Try again shortly" });
          return true;
        }
        sendTagged(request, response, tagged(sitemapOf(origin, repositories)), {
          "cache-control": PAGE_CACHE,
          "content-type": "application/xml; charset=utf-8",
        });
        return true;
      }
      const { status, head, body, data, partial } = await pageOf(url.pathname);
      let html: TaggedBody;
      try {
        html = await page(head, body, data);
      } catch {
        response.setHeader("cache-control", "no-store");
        sendJson(response, 503, { error: "The public site is not built" });
        return true;
      }
      if (status === 200) {
        sendTagged(request, response, html, {
          "cache-control": partial ? "no-store" : PAGE_CACHE,
          "content-type": HTML_TYPE,
        });
        return true;
      }
      // Not cached anywhere, so a repository's first release shows as soon as it is made.
      response.writeHead(404, {
        "content-type": HTML_TYPE,
        "content-length": Buffer.byteLength(html.body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(html.body);
      return true;
    },
  };
}
export type ResultsSite = ReturnType<typeof createResultsSite>;
