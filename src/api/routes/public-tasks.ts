import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactStore } from "../../artifacts/index.js";
import { BundleNotFoundError, expandBundle } from "../../generation/runs/bundle.js";
import type { ReleaseTask } from "../../public/release-rule.js";
import type { PublishedTask, PublishedTaskFiles } from "../../public/release-types.js";
import { TaskArchiveTooLarge, taskArchive } from "../../public/task-archive.js";
import { takesCanary, withCanary } from "../../public/task-canary.js";
import { sendJson } from "../http.js";
import { sendTagged, type TaggedBody, tagged } from "../tagged.js";

/**
 * A release's tasks, their files and their downloads never change (each release pins the
 * compiled task its evaluations ran, and artifacts are written once), but they must go when the
 * release is withdrawn or replaced, within the minute the release dialog promises. So the CDN and
 * browsers keep them a minute, then ask again, and a copy that is still current costs a bodyless
 * 304. A new release has new addresses, so none of this delays one.
 */
const TASK_DATA = "public, max-age=60, s-maxage=60";
const JSON_TYPE = "application/json; charset=utf-8";
/** A task id in an address: the agent's names are letters, digits, `.`, `_` and `-`. */
const TASK_ID = /^[A-Za-z0-9._~-]{1,160}$/;
const ARCHIVE = ".tar.gz";
/** Releases whose task lists are kept, most recently used last. */
const KEPT_RELEASES = 64;

/** One release's tasks: the list it answers with, and each task's compiled bundle by id. */
interface TaskIndex {
  list: TaggedBody;
  bundles: Map<string, string>;
}

/**
 * Each task's public id, in key order: its own id, or, when two tasks of the release share one
 * (the same pull request from two batches), the later ones numbered `~2`, `~3`, …
 */
export function publishedTasks(
  tasks: readonly ReleaseTask[],
): { task: PublishedTask; bundleKey?: string }[] {
  const seen = new Map<string, number>();
  return [...tasks]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((task) => {
      const count = (seen.get(task.taskId) ?? 0) + 1;
      seen.set(task.taskId, count);
      return {
        task: {
          id: count === 1 ? task.taskId : `${task.taskId}~${count}`,
          difficulty: task.difficulty,
          ...(task.sourcePr !== undefined ? { sourcePr: task.sourcePr } : {}),
          ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
          ...(task.repository ? { repository: task.repository } : {}),
        },
        ...(task.bundleKey ? { bundleKey: task.bundleKey } : {}),
      };
    });
}

export interface PublicTaskRoutesOptions {
  /** A release's tasks as its row records them (`ReleaseStore.releasedTasks`). */
  releasedTasks(id: string): Promise<ReleaseTask[] | undefined>;
  artifacts: Pick<ArtifactStore, "stat" | "openReadByKey">;
  /** The canary line each served task carries (task-canary.ts); none without one configured. */
  canary?: string;
}

/**
 * The tasks of a release that published them: the list, each task's files for the viewer, and
 * each task as a download. The caller has checked that the release is current and published its
 * tasks. None of it is for search engines: the tasks are a benchmark, kept out of crawls so it
 * stays out of training data (robots.txt says so too).
 */
export function createPublicTaskRoutes(options: PublicTaskRoutesOptions) {
  const indexes = new Map<string, Promise<TaskIndex | undefined>>();
  const files = new Map<string, TaggedBody>();
  const indexOf = (releaseId: string): Promise<TaskIndex | undefined> => {
    const found = indexes.get(releaseId);
    if (found) {
      indexes.delete(releaseId);
      indexes.set(releaseId, found);
      return found;
    }
    const reading = options.releasedTasks(releaseId).then((tasks) => {
      if (!tasks) return undefined;
      const entries = publishedTasks(tasks);
      return {
        list: tagged(JSON.stringify({ tasks: entries.map((entry) => entry.task) })),
        bundles: new Map(
          entries.flatMap((entry) => (entry.bundleKey ? [[entry.task.id, entry.bundleKey]] : [])),
        ),
      };
    });
    // A failed read is not kept: the next request reads again.
    reading.catch(() => indexes.delete(releaseId));
    indexes.set(releaseId, reading);
    for (const oldest of indexes.keys()) {
      if (indexes.size <= KEPT_RELEASES) break;
      indexes.delete(oldest);
    }
    return reading;
  };
  const missing = (response: ServerResponse, error = "not found") => {
    response.setHeader("cache-control", "no-store");
    sendJson(response, 404, { error });
  };

  return {
    /** Answers `/api/public/releases/<releaseId>/tasks` and below; `rest` follows `tasks`. */
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
      releaseId: string,
      rest: readonly string[],
    ): Promise<void> {
      response.setHeader("x-robots-tag", "noindex");
      const index = await indexOf(releaseId);
      if (!index) return missing(response);
      if (rest.length === 0) {
        sendTagged(request, response, index.list, {
          "cache-control": TASK_DATA,
          "content-type": JSON_TYPE,
        });
        return;
      }
      // `<task>` is its files; `<task>/<task>.tar.gz` its download, named so `curl -O` keeps the
      // name. A task's own id may end in `.tar.gz`, so the two never share a shape.
      const [id = "", file] = rest;
      const download = rest.length === 2 && file === `${id}${ARCHIVE}`;
      const bundleKey =
        (rest.length === 1 || download) && TASK_ID.test(id) ? index.bundles.get(id) : undefined;
      if (!bundleKey) return missing(response, "No such task in this release");
      if (download) return sendArchive(request, response, options, bundleKey, id);
      const key = `${releaseId}/${id}`;
      let body = files.get(key);
      if (!body) {
        let expanded: Awaited<ReturnType<typeof expandBundle>>;
        try {
          expanded = await expandBundle(options.artifacts, bundleKey);
        } catch (error) {
          if (error instanceof BundleNotFoundError)
            return missing(response, "Task files not found");
          throw error;
        }
        const { canary } = options;
        // The same files as the download, so what is shown is what is downloaded.
        const answer: PublishedTaskFiles = {
          taskId: id,
          files: expanded.files.map((file) => {
            if (!canary || file.text === undefined || !takesCanary(file.path)) return file;
            const text = withCanary(file.path, file.text, canary);
            return { ...file, text, sizeBytes: Buffer.byteLength(text) };
          }),
          ...(canary ? { canary } : {}),
        };
        body = tagged(JSON.stringify(answer));
        files.set(key, body);
        for (const oldest of files.keys()) {
          if (files.size <= KEPT_RELEASES) break;
          files.delete(oldest);
        }
      }
      sendTagged(request, response, body, {
        "cache-control": TASK_DATA,
        "content-type": JSON_TYPE,
      });
    },
  };
}

/** The task as a `.tar.gz` named after it, or a 304 when the browser already holds it. */
async function sendArchive(
  request: IncomingMessage,
  response: ServerResponse,
  options: Pick<PublicTaskRoutesOptions, "artifacts" | "canary">,
  bundleKey: string,
  id: string,
): Promise<void> {
  let archive: Awaited<ReturnType<typeof taskArchive>>;
  try {
    archive = await taskArchive(options.artifacts, bundleKey, id, options.canary);
  } catch (error) {
    if (!(error instanceof TaskArchiveTooLarge)) throw error;
    response.setHeader("cache-control", "no-store");
    sendJson(response, 413, { error: "This task is too large to download here" });
    return;
  }
  if (!archive) {
    response.setHeader("cache-control", "no-store");
    sendJson(response, 404, { error: "Task files not found" });
    return;
  }
  response.setHeader("etag", archive.etag);
  response.setHeader("cache-control", TASK_DATA);
  const held = request.headers["if-none-match"]
    ?.split(",")
    .some((tag) => tag.trim().replace(/^W\//, "") === archive.etag);
  if (held) {
    response.writeHead(304).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": archive.bytes.length,
    "content-disposition": `attachment; filename="${id}${ARCHIVE}"`,
    "x-content-type-options": "nosniff",
  });
  response.end(archive.bytes);
}
