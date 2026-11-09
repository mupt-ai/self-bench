import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { ReleaseStore } from "../../db/releases.js";
import { groupPath, pathName, repositoryPath, segmentsOf } from "../../public/paths.js";
import type { PublishedGroup } from "../../public/release-groups.js";
import type { PublishedLine } from "../../public/release-types.js";
import { sendJson } from "../http.js";
import { type Snapshot, snapshotOf } from "../public-snapshot.js";
import { clientIp, type RateLimiter } from "../rate-limit.js";
import { sendTagged } from "../tagged.js";
import { createPublicTaskRoutes, type PublicTaskRoutesOptions } from "./public-tasks.js";

/** How long the snapshot of released lines is served before the next read of the table. */
const SNAPSHOT_MS = 5_000;
/**
 * The same for everyone. The CDN may keep it 10 seconds, and browsers check it on every read, a
 * bodyless 304 while it is unchanged, so a release shows within about 15 seconds wherever it is
 * read. With `s-maxage` the CDN never hands out an expired copy, neither while it refreshes one
 * nor while the API is down. Only a successful read is cached: a miss must never hide a
 * repository's first release.
 */
const CACHED = "public, max-age=0, s-maxage=10";
const JSON_TYPE = "application/json; charset=utf-8";

export interface PublicReleaseRoutesOptions {
  /** Refuses callers over their share; the routes are anonymous. */
  limiter?: RateLimiter;
  now?: () => number;
  /** Where published tasks' files are read from; without it, no release's tasks are served. */
  artifacts?: Pick<ArtifactStore, "stat" | "openReadByKey" | "getByKey">;
  /** Where published trials are read from; without it, no release's trials are served. */
  trials?: PublicTaskRoutesOptions["trials"];
}

/**
 * The routes selfbench.dev reads without signing in. They serve only each release's public
 * payload, from a snapshot of every current line that is read at most once per few seconds
 * however many visitors arrive, so public traffic never reaches the database per request.
 */
export function createPublicReleaseRoutes(
  releases: Pick<ReleaseStore, "currentLines"> &
    Partial<Pick<ReleaseStore, "releasedTasks" | "releasedResults" | "currentGroups">>,
  options: PublicReleaseRoutesOptions = {},
) {
  const now = options.now ?? Date.now;
  const tasks =
    releases.releasedTasks && options.artifacts
      ? createPublicTaskRoutes({
          releasedTasks: releases.releasedTasks.bind(releases),
          artifacts: options.artifacts,
          ...(releases.releasedResults && options.trials
            ? {
                releasedResults: releases.releasedResults.bind(releases),
                trials: options.trials,
              }
            : {}),
        })
      : undefined;
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
      const entry = {
        snapshot: Promise.all([releases.currentLines(), releases.currentGroups?.() ?? []]).then(
          ([lines, records]) => snapshotOf(lines, records),
        ),
        at: now(),
      };
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
    /** The current lines of one repository or benchmark, by `resultsName`, for page status. */
    async linesFor(name: string): Promise<PublishedLine[]> {
      return (await snapshot()).byRepository.get(name.toLowerCase()) ?? [];
    },
    /** Every repository's current lines, for selfbench.dev's sitemap. */
    async repositories(): Promise<PublishedLine[][]> {
      return [...(await snapshot()).byRepository.values()];
    },
    /**
     * The body /api/public/directory answers, for the home page to carry into its first render:
     * the same bytes, built once per snapshot for both.
     */
    async directoryBody(): Promise<string> {
      return (await snapshot()).directory().body;
    },
    /** The body /api/public/results/<name> answers, or undefined when nothing is released. */
    async repositoryBody(name: string): Promise<string | undefined> {
      return (await snapshot()).repository(name)?.body;
    },
    /** Every group with something to show, for the home page and the sitemap. */
    async groups(): Promise<PublishedGroup[]> {
      return (await snapshot()).groups;
    },
    /** One group's page, or undefined when it has nothing to show. */
    async groupFor(publisher: string, slug: string): Promise<PublishedGroup | undefined> {
      return (await snapshot()).group(publisher, slug);
    },
    /** The body /api/public/groups/<publisher>/<slug> answers, or undefined. */
    async groupBody(publisher: string, slug: string): Promise<string | undefined> {
      return (await snapshot()).groupBody(publisher, slug)?.body;
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
      // A release's tasks, served only while it is a current release that published them, and
      // its trials only while it also published those.
      if (route === "releases" && rest[1] === "tasks") {
        const release = (await snapshot()).byRelease.get(rest[0] ?? "");
        if (tasks && release?.tasksPublished) {
          await tasks.handle(request, response, release, rest.slice(2));
        } else {
          uncached();
          response.setHeader("x-robots-tag", "noindex");
          sendJson(response, 404, { error: "This release has no published tasks" });
        }
        return true;
      }
      if (route === "releases" && rest.length === 0) {
        sendTagged(request, response, (await snapshot()).releases(), {
          "cache-control": CACHED,
          "content-type": JSON_TYPE,
        });
        return true;
      }
      if (
        (route === "results" && rest.length === 0) ||
        (route === "directory" && rest.length === 0)
      ) {
        sendTagged(request, response, (await snapshot()).directory(), {
          "cache-control": CACHED,
          "content-type": JSON_TYPE,
        });
        return true;
      }
      const group = route === "groups" ? groupPath([route, ...rest]) : undefined;
      if (group) {
        const body = (await snapshot()).groupBody(group.publisher, group.slug);
        if (body) {
          sendTagged(request, response, body, {
            "cache-control": CACHED,
            "content-type": JSON_TYPE,
          });
        } else {
          uncached();
          sendJson(response, 404, { error: "No such repository group" });
        }
        return true;
      }
      // A repository's results, `<owner>/<name>`, or a public benchmark's, `evals/<org>/<name>`.
      const path = route === "results" || route === "repos" ? repositoryPath(rest) : undefined;
      const repository = path && !path.publisher ? path : undefined;
      if (repository) {
        const body = (await snapshot()).repository(pathName(repository));
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
