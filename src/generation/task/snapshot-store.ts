import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import { SNAPSHOT_FILE } from "../../sandbox/gate-bundle.js";

/** Written beside a compile attempt once its snapshot moved to the shared copy. */
export const SNAPSHOT_POINTER_FILE = "repo.json";

/** One repository snapshot as stored, pinned to its content. */
export interface StoredSnapshot {
  readonly key: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const pointerSchema = z.object({
  key: z.string(),
  sha256: z.string().regex(sha256Pattern),
  sizeBytes: z.number().int().nonnegative(),
});

/**
 * The one copy of a snapshot with this content. `git archive` gives the same bytes for the same
 * commit, so every compile attempt of a task, and every task of the same base commit, shares it.
 */
export function sharedSnapshotKey(sha256: string): string {
  if (!sha256Pattern.test(sha256)) throw new Error("snapshot digest must be a SHA-256");
  return `snapshots/${sha256}.tar.gz`;
}

/**
 * The repository snapshot a compile attempt wrote at `directory`: its own copy, when it still has
 * one, or the shared copy its pointer names. Undefined when it has neither (tasks with services).
 */
export async function attemptSnapshot(
  store: Pick<ArtifactStore, "stat" | "getByKey">,
  directory: string,
): Promise<StoredSnapshot | undefined> {
  const own = `${directory}/${SNAPSHOT_FILE}`;
  const found = await store.stat(own);
  if (found) return { key: own, sha256: found.sha256, sizeBytes: found.sizeBytes };
  const bytes = await store.getByKey(`${directory}/${SNAPSHOT_POINTER_FILE}`);
  if (!bytes) return undefined;
  const pointer = pointerSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (pointer.key !== sharedSnapshotKey(pointer.sha256))
    throw new Error(`snapshot pointer at ${directory} names an unshared key`);
  return pointer;
}

/**
 * Moves a compile attempt's own snapshot to the shared copy and leaves a pointer to it. The shared
 * copy is read through once when it is first made, so its stored digest is known to be its
 * content; the attempt's copy goes only after the pointer is written. Repeating it is harmless.
 * Returns the bytes this freed, or undefined when the attempt had no snapshot of its own.
 */
export async function shareSnapshot(
  store: ArtifactStore,
  directory: string,
): Promise<{ readonly snapshot: StoredSnapshot; readonly freedBytes: number } | undefined> {
  const own = `${directory}/${SNAPSHOT_FILE}`;
  const found = await store.stat(own);
  if (!found) return undefined;
  const key = sharedSnapshotKey(found.sha256);
  const existing = await store.stat(key);
  if (existing && (existing.sha256 !== found.sha256 || existing.sizeBytes !== found.sizeBytes))
    throw new Error(`shared snapshot ${key} differs from ${own}`);
  if (!existing) {
    const copied = await store.copy(own, key);
    // A verified read throws when the bytes do not hash to the recorded digest.
    for await (const _ of await store.openRead({ ...copied, contentType: "application/gzip" })) {
      // Read through.
    }
  }
  const snapshot = { key, sha256: found.sha256, sizeBytes: found.sizeBytes };
  await store.put(
    `${directory}/${SNAPSHOT_POINTER_FILE}`,
    Buffer.from(`${JSON.stringify(snapshot)}\n`),
    "application/json",
  );
  await store.delete(own);
  return { snapshot, freedBytes: existing ? found.sizeBytes : 0 };
}
