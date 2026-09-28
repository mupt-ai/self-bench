import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReleaseStore } from "../../db/releases.js";
import { directoryOf } from "../../public/directory.js";
import { repositoryPath, segmentsOf } from "../../public/paths.js";
import type { PublishedLine } from "../../public/release-types.js";
import { sendJson, sendTagged, type TaggedBody, tagged } from "../http.js";
import { clientIp, type RateLimiter } from "../rate-limit.js";

/** How long the snapshot of released lines is served before the next read of the table. */
const SNAPSHOT_MS = 5_000;
/**
 * The same for everyone, so the CDN and browsers may keep it a minute. Only a successful
 * read is cached: a miss must never hide a repository's first release.
 */
const CACHED = "public, max-age=60";
const JSON_TYPE = "application/json; charset=utf-8";

/**
 * Every current release line, as read at one moment, with the public responses built from it.
 * Each response is built and tagged the first time it is asked for, then reused until the next
 * read, so a request costs no read of the table and a client or CDN already holding a response
 * is answered with a bodyless 304.
 */
interface Snapshot {
  /** Current lines by lower-case repository name, newest first. */
  byRepository: Map<string, PublishedLine[]>;
  releases: () => TaggedBody;
  directory: () => TaggedBody;
  /** One repository's response, or undefined when nothing is released for it. */
  repository: (fullName: string) => TaggedBody | undefined;
}

/** `build`, run once on first use. */
function once<T>(build: () => T): () => T {
  let built: { value: T } | undefined;
  return () => {
    built ??= { value: build() };
    return built.value;
  };
}

function snapshotOf(lines: PublishedLine[]): Snapshot {
  const byRepository = new Map<string, PublishedLine[]>();
  for (const line of lines) {
    const key = line.release.repository.fullName.toLowerCase();
    byRepository.set(key, [...(byRepository.get(key) ?? []), line]);
  }
  const repositories = new Map<string, TaggedBody>();
  return {
    byRepository,
    releases: once(() => tagged(JSON.stringify({ lines }))),
    directory: once(() => tagged(JSON.stringify({ cards: directoryOf(lines) }))),
    repository(fullName) {
      const key = fullName.toLowerCase();
      const found = byRepository.get(key);
      if (!found) return undefined;
      let body = repositories.get(key);
      if (!body) {
        body = tagged(JSON.stringify({ lines: found }));
        repositories.set(key, body);
      }
      return body;
    },
  };
}

export interface PublicReleaseRoutesOptions {
  /** Refuses callers over their share; the routes are anonymous. */
  limiter?: RateLimiter;
  now?: () => number;
}

/**
 * The routes selfbench.dev reads without signing in. They serve only each release's public
 * payload, from a snapshot of every current line that is read at most once per few seconds
 * however many visitors arrive, so public traffic never reaches the database per request.
 */
export function createPublicReleaseRoutes(
  releases: Pick<ReleaseStore, "currentLines">,
  options: PublicReleaseRoutesOptions = {},
) {
  const now = options.now ?? Date.now;
  let reading: { snapshot: Promise<Snapshot>; at: number } | undefined;
  /** The newest successful read, by when it started: an older read finishing later never wins. */
  let lastGood: { snapshot: Snapshot; read: number } | undefined;
  let reads = 0;
  /**
   * The snapshot, read again when it is older than a few seconds. Concurrent requests share one
   * read. A failed read is never kept: the last good snapshot stands in until the next read is
   * due, and with none yet the next request reads again.
   */
  const snapshot = (): Promise<Snapshot> => {
    if (!reading || now() - reading.at >= SNAPSHOT_MS) {
      reads += 1;
      const read = reads;
      const entry = { snapshot: releases.currentLines().then(snapshotOf), at: now() };
      reading = entry;
      entry.snapshot.then(
        (snapshot) => {
          if (!lastGood || read > lastGood.read) lastGood = { snapshot, read };
        },
        () => {
          if (reading !== entry) return;
          reading = lastGood
            ? { snapshot: Promise.resolve(lastGood.snapshot), at: entry.at }
            : undefined;
        },
      );
    }
    return reading.snapshot.catch((error: unknown) => {
      if (lastGood) return lastGood.snapshot;
      throw error;
    });
  };

  return {
    /**
     * Reads the lines afresh on the next request: this server just released or withdrew
     * something, and the person who did it should see it at once.
     */
    refresh() {
      reading = undefined;
    },
    /** The current lines of one repository, for the page status of selfbench.dev. */
    async linesFor(fullName: string): Promise<PublishedLine[]> {
      return (await snapshot()).byRepository.get(fullName.toLowerCase()) ?? [];
    },
    /** Answers /api/public/*; true when the response was sent. */
    async handle(request: IncomingMessage, url: URL, response: ServerResponse): Promise<boolean> {
      if (!url.pathname.startsWith("/api/public/")) return false;
      const uncached = () => response.setHeader("cache-control", "no-store");
      if (request.method !== "GET" && request.method !== "HEAD") {
        uncached();
        sendJson(response, 405, { error: "Method not allowed" });
        return true;
      }
      const verdict = options.limiter?.take(clientIp(request)) ?? { ok: true };
      if (!verdict.ok) {
        uncached();
        response.setHeader("retry-after", String(verdict.retryAfter));
        sendJson(response, 429, { error: "Too many requests; try again shortly" });
        return true;
      }
      const [, , route, ...rest] = segmentsOf(url.pathname);
      if (route === "releases" && rest.length === 0) {
        sendTagged(request, response, (await snapshot()).releases(), {
          "cache-control": CACHED,
          "content-type": JSON_TYPE,
        });
        return true;
      }
      if (route === "directory" && rest.length === 0) {
        sendTagged(request, response, (await snapshot()).directory(), {
          "cache-control": CACHED,
          "content-type": JSON_TYPE,
        });
        return true;
      }
      const repository = route === "repos" && rest.length === 2 ? repositoryPath(rest) : undefined;
      if (repository) {
        const body = (await snapshot()).repository(`${repository.owner}/${repository.name}`);
        if (body) {
          sendTagged(request, response, body, {
            "cache-control": CACHED,
            "content-type": JSON_TYPE,
          });
        } else {
          uncached();
          sendJson(response, 404, { error: "Nothing released for this repository" });
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
