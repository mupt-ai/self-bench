import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { extractRegularArchive } from "../archive.js";
import type { ArtifactStore } from "../artifacts.js";
import { sha256 } from "../hash.js";
import { isHarborTaskDirectory, readTaskDirectory } from "./task-files.js";
import type { TaskFiles } from "./types.js";

const inFlight = new Map<string, Promise<TaskFiles>>();

export function bundleCacheRoot(): string {
  return join(tmpdir(), "selfbench-viewer-bundles");
}

export async function expandBundle(store: ArtifactStore, key: string): Promise<TaskFiles> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = expandUncached(store, key).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function expandUncached(store: ArtifactStore, key: string): Promise<TaskFiles> {
  const cacheDirectory = join(bundleCacheRoot(), sha256(key));
  const ready = join(cacheDirectory, "ready");
  if (!(await exists(ready))) {
    await materialize(store, key, cacheDirectory);
  }
  const taskDirectory = await locateTaskDirectory(ready);
  return readTaskDirectory(taskDirectory, taskIdFromKey(key));
}

async function materialize(store: ArtifactStore, key: string, cacheDirectory: string) {
  const staging = join(cacheDirectory, "staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const archive = join(staging, "bundle.tar.gz");
  const body = await store.openReadByKey(key);
  if (!body) {
    throw new BundleNotFoundError(key);
  }
  await pipeline(body, createWriteStream(archive, { mode: 0o600 }));
  const extracted = join(staging, "extracted");
  await mkdir(extracted);
  await extractRegularArchive(archive, extracted);
  await rm(archive, { force: true });
  await rename(extracted, join(cacheDirectory, "ready"));
  await rm(staging, { recursive: true, force: true });
}

async function locateTaskDirectory(root: string): Promise<string> {
  for (const candidate of [join(root, "harbor-task"), root]) {
    if (await isHarborTaskDirectory(candidate)) return candidate;
  }
  return root;
}

function taskIdFromKey(key: string): string {
  const segments = key.split("/");
  const name = basename(key);
  // .../authoring/<candidateId>/source-task.tar.gz or .../<group>/<taskId>/<hash>/.../harbor-task.tar.gz
  const groupIndex = segments.findIndex((segment, index) => index >= 2 && segment !== "runs");
  const taskSegment = segments[groupIndex + 1];
  return taskSegment ?? name.replace(/\.tar\.gz$/, "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export class BundleNotFoundError extends Error {
  constructor(key: string) {
    super(`bundle not found: ${key}`);
  }
}

export async function clearBundleCache(): Promise<void> {
  await rm(bundleCacheRoot(), { recursive: true, force: true });
}
