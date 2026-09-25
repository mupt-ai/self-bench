import { basename, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import type { ArtifactStore } from "../../artifacts/index.js";
import { type BundleFile, isInlineCandidate, taskFilesFromBundle } from "./task-files.js";
import type { TaskFiles } from "./types.js";

const MAX_BUNDLE_ENTRIES = 20_000;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;

const inFlight = new Map<string, Promise<TaskFiles>>();
/** Expanded bundles by key and digest, least recently used first. */
const expanded = new Map<string, { files: TaskFiles; bytes: number }>();
let expandedBytes = 0;

/**
 * Viewer files for the bundle at `key`. Expanding means streaming and gunzipping the whole
 * archive, repository snapshot included, so results are kept in memory by content digest:
 * a task page that re-reads the same bundle costs one metadata lookup instead of a full pass.
 */
export async function expandBundle(store: ArtifactStore, key: string): Promise<TaskFiles> {
  const object = await store.stat(key);
  // Objects written without a recorded digest are expanded every time rather than cached.
  const identity = object ? `${key}@${object.sha256}` : undefined;
  const cached = identity ? expanded.get(identity) : undefined;
  if (identity && cached) {
    expanded.delete(identity);
    expanded.set(identity, cached);
    return cached.files;
  }
  const flight = identity ?? key;
  const pending = inFlight.get(flight);
  if (pending) return pending;
  const promise = expand(store, key)
    .then((files) => {
      if (identity) remember(identity, files);
      return files;
    })
    .finally(() => inFlight.delete(flight));
  inFlight.set(flight, promise);
  return promise;
}

function remember(identity: string, files: TaskFiles): void {
  const bytes = files.files.reduce(
    (total, file) => total + file.path.length + (file.text?.length ?? 0),
    0,
  );
  if (bytes > MAX_CACHED_BYTES) return;
  expanded.set(identity, { files, bytes });
  expandedBytes += bytes;
  for (const [oldest, entry] of expanded) {
    if (expandedBytes <= MAX_CACHED_BYTES) break;
    expanded.delete(oldest);
    expandedBytes -= entry.bytes;
  }
}

/**
 * Streams the bundle straight from the artifact store and keeps only the small text files the
 * viewer shows. Nothing touches disk: the repository snapshots (hundreds of MB) are skipped as
 * they stream past, where a persistent unpacked cache once filled the API's boot disk.
 */
async function expand(store: ArtifactStore, key: string): Promise<TaskFiles> {
  const body = await store.openReadByKey(key);
  if (!body) {
    throw new BundleNotFoundError(key);
  }
  const archive = extract();
  const streaming = pipeline(body, createGunzip(), archive);
  // A stream failure also ends the loop below; it is rethrown by the final await.
  streaming.catch(() => undefined);
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  for await (const entry of archive) {
    const { name, size = 0, type } = entry.header;
    if (type !== "file") {
      entry.resume();
      continue;
    }
    const path = bundlePath(name);
    if (seen.has(path) || seen.size >= MAX_BUNDLE_ENTRIES) {
      archive.destroy();
      throw new Error(`bundle repeats ${path} or has too many files`);
    }
    seen.add(path);
    if (!isInlineCandidate(path, size)) {
      entry.resume();
      files.push({ path, sizeBytes: size });
      continue;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of entry) chunks.push(chunk as Buffer);
    files.push({ path, sizeBytes: size, bytes: Buffer.concat(chunks) });
  }
  await streaming;
  return taskFilesFromBundle(files, taskIdFromKey(key));
}

function bundlePath(name: string): string {
  const path = posix.normalize(name.replace(/^\.\/+/, ""));
  if (!path || path === "." || path === ".." || path.startsWith("/") || path.startsWith("../")) {
    throw new Error(`bundle path escapes its root: ${name}`);
  }
  return path;
}

function taskIdFromKey(key: string): string {
  const segments = key.split("/");
  const name = basename(key);
  // .../authoring/<candidateId>/source-task.tar.gz or .../<group>/<taskId>/<hash>/.../harbor-task.tar.gz
  const groupIndex = segments.findIndex((segment, index) => index >= 2 && segment !== "runs");
  const taskSegment = segments[groupIndex + 1];
  return taskSegment ?? name.replace(/\.tar\.gz$/, "");
}

export class BundleNotFoundError extends Error {
  constructor(key: string) {
    super(`bundle not found: ${key}`);
  }
}
