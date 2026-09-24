import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ArtifactStore } from "../../artifacts/index.js";
import { extractRegularArchive } from "../../lib/archive.js";
import { isHarborTaskDirectory, readTaskDirectory } from "./task-files.js";
import type { TaskFiles } from "./types.js";

const inFlight = new Map<string, Promise<TaskFiles>>();

export async function expandBundle(store: ArtifactStore, key: string): Promise<TaskFiles> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = expand(store, key).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// Expanded per request and removed afterwards: a persistent cache here once grew without bound
// on the API's boot disk and helped fill it.
async function expand(store: ArtifactStore, key: string): Promise<TaskFiles> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-viewer-bundle-"));
  try {
    const body = await store.openReadByKey(key);
    if (!body) {
      throw new BundleNotFoundError(key);
    }
    const archive = join(root, "bundle.tar.gz");
    await pipeline(body, createWriteStream(archive, { mode: 0o600 }));
    const extracted = join(root, "extracted");
    await mkdir(extracted);
    await extractRegularArchive(archive, extracted);
    return await readTaskDirectory(await locateTaskDirectory(extracted), taskIdFromKey(key));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

export class BundleNotFoundError extends Error {
  constructor(key: string) {
    super(`bundle not found: ${key}`);
  }
}
