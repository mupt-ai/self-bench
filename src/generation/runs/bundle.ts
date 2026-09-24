import { basename, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import type { ArtifactStore } from "../../artifacts/index.js";
import { type BundleFile, isInlineCandidate, taskFilesFromBundle } from "./task-files.js";
import type { TaskFiles } from "./types.js";

const MAX_BUNDLE_ENTRIES = 20_000;

const inFlight = new Map<string, Promise<TaskFiles>>();

export async function expandBundle(store: ArtifactStore, key: string): Promise<TaskFiles> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = expand(store, key).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
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
