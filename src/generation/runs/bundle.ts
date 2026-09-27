import { basename, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import type { ArtifactStore } from "../../artifacts/index.js";
import { GATE_TASK_FILE, SNAPSHOT_FILE, SNAPSHOT_PATHS } from "../../sandbox/gate-bundle.js";
import { type BundleFile, isInlineCandidate, taskFilesFromBundle } from "./task-files.js";
import type { TaskFiles } from "./types.js";

const MAX_BUNDLE_ENTRIES = 20_000;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;

const inFlight = new Map<string, Promise<TaskFiles>>();
/** Expanded bundles by key and digest, least recently used first. */
const expanded = new Map<string, { files: TaskFiles; bytes: number }>();
let expandedBytes = 0;

/**
 * Viewer files for the bundle at `key`. A compiled bundle is read from the gate task the compiler
 * wrote beside it, which is the same tree without its repository snapshots, so opening a task
 * streams kilobytes instead of the hundreds of MB the snapshots weigh. Other bundles are streamed
 * whole. Results are kept in memory by content digest: a task page that re-reads the same bundle
 * costs one metadata lookup instead of a full pass.
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

async function expand(store: ArtifactStore, key: string): Promise<TaskFiles> {
  const light = await withoutSnapshots(store, key);
  if (light) {
    const files = await readArchive(store, light.key);
    if (files) return taskFilesFromBundle([...files, ...light.snapshots], taskIdFromKey(key));
  }
  const files = await readArchive(store, key);
  if (!files) throw new BundleNotFoundError(key);
  return taskFilesFromBundle(files, taskIdFromKey(key));
}

/**
 * The gate task beside a compiled bundle, with the snapshot entries it leaves out listed by size.
 * Tasks with services, and bundles compiled before the split existed, have no gate task.
 */
async function withoutSnapshots(
  store: ArtifactStore,
  key: string,
): Promise<{ key: string; snapshots: BundleFile[] } | undefined> {
  const suffix = "/harbor-task.tar.gz";
  if (!key.endsWith(suffix)) return undefined;
  const directory = key.slice(0, -suffix.length);
  const [gate, snapshot] = await Promise.all([
    store.stat(`${directory}/${GATE_TASK_FILE}`),
    store.stat(`${directory}/${SNAPSHOT_FILE}`),
  ]);
  if (!gate || !snapshot) return undefined;
  return {
    key: `${directory}/${GATE_TASK_FILE}`,
    snapshots: SNAPSHOT_PATHS.map((path) => ({ path, sizeBytes: snapshot.sizeBytes })),
  };
}

/**
 * Streams an archive straight from the artifact store and keeps only the small text files the
 * viewer shows; undefined when there is no object at `key`. Nothing touches disk: large entries
 * are skipped as they stream past, where a persistent unpacked cache once filled the API's disk.
 */
async function readArchive(store: ArtifactStore, key: string): Promise<BundleFile[] | undefined> {
  const body = await store.openReadByKey(key);
  if (!body) return undefined;
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
  return files;
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
