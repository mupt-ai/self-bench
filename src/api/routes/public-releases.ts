import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { GroupReleaseStore } from "../../db/group-releases.js";
import type { ReleaseStore } from "../../db/releases.js";
import { directoryOf, groupCardsOf } from "../../public/directory.js";
import { groupSlug, repositoryPath, segmentsOf } from "../../public/paths.js";
import type {
  PublishedGroupRelease,
  PublishedLine,
  PublishedRelease,
} from "../../public/release-types.js";
import { sendJson } from "../http.js";
import { clientIp, type RateLimiter } from "../rate-limit.js";
import { sendTagged, type TaggedBody, tagged } from "../tagged.js";
import { createPublicTaskRoutes } from "./public-tasks.js";

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

/**
 * Every current release line, as read at one moment, with the public responses built from it.
 * Each response is built and tagged the first time it is asked for, then reused until the next
 * read, so a request costs no read of the table and a client or CDN already holding a response
 * is answered with a bodyless 304.
 */
interface Snapshot {
  /** Current lines by lower-case repository name, newest first. */
  byRepository: Map<string, PublishedLine[]>;
  /** Each group's current release, by lower-case slug. */
  byGroup: Map<string, PublishedGroupRelease>;
  /** Current releases by id, repositories' and groups' alike. */
  byRelease: Map<string, Pick<PublishedRelease, "releaseId" | "tasksPublished">>;
  releases: () => TaggedBody;
  directory: () => TaggedBody;
  groups: () => TaggedBody;
  /** One repository's response, or undefined when nothing is released for it. */
  repository: (fullName: string) => TaggedBody | undefined;
  /** One group's response, or undefined when it has no current release. */
  group: (slug: string) => TaggedBody | undefined;
}

/** `build`, run once on first use. */
function once<T>(build: () => T): () => T {
  let built: { value: T } | undefined;
  return () => {
    built ??= { value: build() };
    return built.value;
  };
}

/** A response per key, built and tagged the first time it is asked for. */
function bodies<V>(found: Map<string, V>, build: (value: V) => string) {
  const built = new Map<string, TaggedBody>();
  return (key: string) => {
    const value = found.get(key.toLowerCase());
    if (value === undefined) return undefined;
    let body = built.get(key.toLowerCase());
    if (!body) {
      body = tagged(build(value));
      built.set(key.toLowerCase(), body);
    }
    return body;
  };
}

function snapshotOf(lines: PublishedLine[], groups: PublishedGroupRelease[]): Snapshot {
  const byRepository = new Map<string, PublishedLine[]>();
  for (const line of lines) {
    const key = line.release.repository.fullName.toLowerCase();
    byRepository.set(key, [...(byRepository.get(key) ?? []), line]);
  }
  const byGroup = new Map(groups.map((release) => [release.group.slug.toLowerCase(), release]));
  return {
    byRepository,
    byGroup,
    byRelease: new Map<string, Pick<PublishedRelease, "releaseId" | "tasksPublished">>([
      ...lines.map((line) => [line.release.releaseId, line.release] as const),
      ...groups.map((release) => [release.releaseId, release] as const),
    ]),
    releases: once(() => tagged(JSON.stringify({ lines }))),
    directory: once(() =>
      tagged(JSON.stringify({ cards: directoryOf(lines), groups: groupCardsOf(groups) })),
    ),
    groups: once(() => tagged(JSON.stringify({ groups }))),
    repository: bodies(byRepository, (found) => JSON.stringify({ lines: found })),
    group: bodies(byGroup, (release) => JSON.stringify({ release })),
  };
}

export interface PublicReleaseRoutesOptions {
  /** Refuses callers over their share; the routes are anonymous. */
  limiter?: RateLimiter;
  now?: () => number;
  /** Where published tasks' files are read from; without it, no release's tasks are served. */
  artifacts?: Pick<ArtifactStore, "stat" | "openReadByKey">;
  /** The canary line published tasks carry (src/public/task-canary.ts). */
  taskCanary?: string;
  /** Groups' releases, served beside repositories'. */
  groupReleases?: Pick<GroupReleaseStore, "currentLines" | "releasedTasks">;
}

/**
 * The routes selfbench.dev reads without signing in. They serve only each release's public
 * payload, from a snapshot of every current line that is read at most once per few seconds
 * however many visitors arrive, so public traffic never reaches the database per request.
 */
export function createPublicReleaseRoutes(
  releases: Pick<ReleaseStore, "currentLines"> & Partial<Pick<ReleaseStore, "releasedTasks">>,
  options: PublicReleaseRoutesOptions = {},
) {
  const now = options.now ?? Date.now;
  const { groupReleases } = options;
  const releasedTasks = releases.releasedTasks?.bind(releases);
  const tasks =
    releasedTasks && options.artifacts
      ? createPublicTaskRoutes({
          // A release id names a repository's release or a group's, never both.
          releasedTasks: async (id) =>
            (await releasedTasks(id)) ?? (await groupReleases?.releasedTasks(id)),
          artifacts: options.artifacts,
          ...(options.taskCanary ? { canary: options.taskCanary } : {}),
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
        snapshot: Promise.all([releases.currentLines(), groupReleases?.currentLines() ?? []]).then(
          ([lines, groups]) => snapshotOf(lines, groups),
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
    /** The current lines of one repository, for the page status of selfbench.dev. */
    async linesFor(fullName: string): Promise<PublishedLine[]> {
      return (await snapshot()).byRepository.get(fullName.toLowerCase()) ?? [];
    },
    /** Every repository's current lines, for selfbench.dev's sitemap. */
    async repositories(): Promise<PublishedLine[][]> {
      return [...(await snapshot()).byRepository.values()];
    },
    /** A group's current release, for the page status of selfbench.dev. */
    async groupFor(slug: string): Promise<PublishedGroupRelease | undefined> {
      return (await snapshot()).byGroup.get(slug.toLowerCase());
    },
    /** Every group's current release, for selfbench.dev's sitemap. */
    async groups(): Promise<PublishedGroupRelease[]> {
      return [...(await snapshot()).byGroup.values()];
    },
    /** The body /api/public/groups/<slug> answers, or undefined when it has no release. */
    async groupBody(slug: string): Promise<string | undefined> {
      return (await snapshot()).group(slug)?.body;
    },
    /**
     * The body /api/public/directory answers, for the home page to carry into its first render:
     * the same bytes, built once per snapshot for both.
     */
    async directoryBody(): Promise<string> {
      return (await snapshot()).directory().body;
    },
    /** The body /api/public/repos/<owner>/<name> answers, or undefined when nothing is released. */
    async repositoryBody(fullName: string): Promise<string | undefined> {
      return (await snapshot()).repository(fullName)?.body;
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
      // A release's tasks, served only while it is a current release that published them.
      if (route === "releases" && rest[1] === "tasks") {
        const release = (await snapshot()).byRelease.get(rest[0] ?? "");
        if (tasks && release?.tasksPublished) {
          await tasks.handle(request, response, release.releaseId, rest.slice(2));
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
      if (route === "groups" && rest.length === 0) {
        sendTagged(request, response, (await snapshot()).groups(), {
          "cache-control": CACHED,
          "content-type": JSON_TYPE,
        });
        return true;
      }
      const slug = route === "groups" && rest.length === 1 ? groupSlug(rest[0]) : undefined;
      if (slug) {
        const body = (await snapshot()).group(slug);
        if (body) {
          sendTagged(request, response, body, {
            "cache-control": CACHED,
            "content-type": JSON_TYPE,
          });
        } else {
          uncached();
          sendJson(response, 404, { error: "Nothing released for this group" });
        }
        return true;
      }
      const repository =
        (route === "results" || route === "repos") && rest.length === 2
          ? repositoryPath(rest)
          : undefined;
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
