import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import type { ReleaseStore } from "../db/releases.js";
import { contentType, sendJson } from "./http.js";
import { clientIp, type RateLimiter } from "./rate-limit.js";
import type { PublicReleaseRoutes } from "./routes/public-releases.js";

export interface ResultsSiteOptions {
  /** Where selfbench.dev lives; requests for its host are this site's, all others the app's. */
  siteUrl: string;
  /** The app's origin, for the site's Sign In links. */
  appUrl: string;
  /** Whether search engines may index the site: true for prod, false for dev. */
  indexable: boolean;
  /** The built public site, `dist/public-site`. */
  root: string;
  releases: Pick<ReleaseStore, "currentLinesFor">;
  publicRoutes: PublicReleaseRoutes;
  limiter?: RateLimiter;
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

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

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
  let shell: Promise<string> | undefined;
  const page = () => {
    shell ??= readFile(resolve(root, "index.html"), "utf8").then((html) =>
      html.replace(
        "</head>",
        `    <meta name="selfbench-app-url" content="${escapeAttribute(options.appUrl)}" />\n${
          options.indexable ? "" : '    <meta name="robots" content="noindex" />\n'
        }  </head>`,
      ),
    );
    shell.catch(() => {
      shell = undefined;
    });
    return shell;
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
  /** 200 for the directory and released repositories, 404 for anything the site cannot show. */
  const statusOf = async (pathname: string) => {
    if (pathname === "/") return 200;
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [owner, name, publisher] = parts;
    if (!owner || !name || parts.length > 3) return 404;
    const lines = await options.releases.currentLinesFor(`${owner}/${name}`);
    const found = publisher
      ? lines.some((line) => line.release.publisher.login.toLowerCase() === publisher.toLowerCase())
      : lines.length > 0;
    return found ? 200 : 404;
  };

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
      if (url.pathname === "/robots.txt") {
        const body = `User-agent: *\n${options.indexable ? "Allow" : "Disallow"}: /\n`;
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600",
        });
        response.end(body);
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
      // A page: the site's shell. Its status says whether the repository has anything released,
      // which is what crawlers and link previews see; the page itself renders in the browser.
      const verdict = options.limiter?.take(clientIp(request)) ?? { ok: true };
      if (!verdict.ok) {
        response.setHeader("retry-after", String(verdict.retryAfter));
        sendJson(response, 429, { error: "Too many requests; try again shortly" });
        return true;
      }
      let html: string;
      try {
        html = await page();
      } catch {
        sendJson(response, 503, { error: "The public site is not built" });
        return true;
      }
      const status = await statusOf(url.pathname).catch(() => 404);
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(html);
      return true;
    },
  };
}
export type ResultsSite = ReturnType<typeof createResultsSite>;
