import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReleaseStore } from "../../db/releases.js";
import type { PublishedLine } from "../../public/release-types.js";
import { sendJson } from "../http.js";
import { clientIp, type RateLimiter } from "../rate-limit.js";

const NAME = "([A-Za-z0-9_.-]+)";
const repoRoute = new RegExp(`^/api/public/repos/${NAME}/${NAME}$`);

/** How long the directory is served from memory before the next read of the table. */
const DIRECTORY_MS = 5_000;

export interface PublicReleaseRoutesOptions {
  /** Refuses callers over their share; the routes are anonymous. */
  limiter?: RateLimiter;
  now?: () => number;
}

/**
 * The routes selfbench.dev reads without signing in. They touch only the releases table and
 * serve only each row's public payload: every line's current release, or one repository's lines.
 */
export function createPublicReleaseRoutes(
  releases: ReleaseStore,
  options: PublicReleaseRoutesOptions = {},
) {
  const now = options.now ?? Date.now;
  // Concurrent visitors share one read; a failed read is dropped, never served again.
  let directory: { lines: Promise<PublishedLine[]>; at: number } | undefined;
  const currentLines = () => {
    if (!directory || now() - directory.at >= DIRECTORY_MS) {
      const lines = releases.currentLines();
      const entry = { lines, at: now() };
      directory = entry;
      lines.catch(() => {
        if (directory === entry) directory = undefined;
      });
    }
    return directory.lines;
  };
  return {
    /** Answers /api/public/*; true when the response was sent. */
    async handle(request: IncomingMessage, url: URL, response: ServerResponse): Promise<boolean> {
      if (!url.pathname.startsWith("/api/public/")) return false;
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed" });
        return true;
      }
      const uncached = () => response.setHeader("cache-control", "no-store");
      const verdict = options.limiter?.take(clientIp(request)) ?? { ok: true };
      if (!verdict.ok) {
        uncached();
        response.setHeader("retry-after", String(verdict.retryAfter));
        sendJson(response, 429, { error: "Too many requests; try again shortly" });
        return true;
      }
      // The same for everyone, so a short cache is safe. Only a successful read is cached: a
      // miss or a failure must never hide a repository's first release for a minute.
      const cached = () => response.setHeader("cache-control", "public, max-age=60");
      if (url.pathname === "/api/public/releases") {
        const lines = await currentLines();
        cached();
        sendJson(response, 200, { lines });
        return true;
      }
      const repo = repoRoute.exec(url.pathname);
      if (repo?.[1] && repo[2]) {
        const lines = await releases.currentLinesFor(`${repo[1]}/${repo[2]}`);
        if (lines.length === 0) {
          uncached();
          sendJson(response, 404, { error: "Nothing released for this repository" });
        } else {
          cached();
          sendJson(response, 200, { lines });
        }
        return true;
      }
      uncached();
      sendJson(response, 404, { error: "not found" });
      return true;
    },
  };
}
export type PublicReleaseRoutes = ReturnType<typeof createPublicReleaseRoutes>;
