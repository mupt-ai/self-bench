import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import type { ArtifactStore } from "../../artifacts/index.js";
import { GATE_TASK_FILE, SNAPSHOT_FILE, SNAPSHOT_PATHS } from "../../sandbox/gate-bundle.js";
import { attemptSnapshot, sharedSnapshotKey, shareSnapshot } from "../task/snapshot-store.js";

const COMPILED_BUNDLE = "harbor-task.tar.gz";
const EXECUTION_BUNDLE = "/execution-task.tar.gz";

export interface Compaction {
  readonly snapshotsShared: number;
  readonly bundlesDeleted: number;
  readonly freedBytes: number;
  /** Full bundles kept because the gate task and snapshot did not rebuild them. */
  readonly mismatched: readonly string[];
}

const NOTHING: Compaction = {
  snapshotsShared: 0,
  bundlesDeleted: 0,
  freedBytes: 0,
  mismatched: [],
};

function add(left: Compaction, right: Compaction): Compaction {
  return {
    snapshotsShared: left.snapshotsShared + right.snapshotsShared,
    bundlesDeleted: left.bundlesDeleted + right.bundlesDeleted,
    freedBytes: left.freedBytes + right.freedBytes,
    mismatched: [...left.mismatched, ...right.mismatched],
  };
}

/**
 * The bundles a task row or saved record still delivers: the bundle itself, and for an execution
 * bundle the compiled bundle published beside it (the source a later export reads).
 */
export function keptBundles(bundleKeys: Iterable<string>): Set<string> {
  const kept = new Set<string>();
  for (const key of bundleKeys) {
    kept.add(key);
    if (key.endsWith(EXECUTION_BUNDLE)) kept.add(`${dirname(dirname(key))}/${COMPILED_BUNDLE}`);
  }
  return kept;
}

export interface CompactionOptions {
  readonly kept: ReadonlySet<string>;
  readonly apply: boolean;
  /** Snapshot digests a dry run already counted, so it reports what applying would free. */
  readonly seen?: Set<string>;
}

/**
 * Compacts one compile attempt at `directory`: its snapshot moves to the one shared copy, and,
 * unless `kept` names it, its full bundle goes once the gate task and snapshot are shown to hold
 * exactly the same files. Attempts without a gate task (tasks with services, older compiles) keep
 * their full bundle. A dry run reports what would be freed without changing anything.
 */
async function compactAttempt(
  store: ArtifactStore,
  directory: string,
  options: CompactionOptions,
): Promise<Compaction> {
  const bundleKey = `${directory}/${COMPILED_BUNDLE}`;
  const [bundle, gate, own] = await Promise.all([
    store.stat(bundleKey),
    store.stat(`${directory}/${GATE_TASK_FILE}`),
    store.stat(`${directory}/${SNAPSHOT_FILE}`),
  ]);
  let result = NOTHING;
  if (own) {
    if (options.apply) {
      const shared = await shareSnapshot(store, directory);
      result = { ...result, snapshotsShared: 1, freedBytes: shared?.freedBytes ?? 0 };
    } else {
      // The first attempt of each content keeps its bytes, as the shared copy.
      const duplicate =
        options.seen?.has(own.sha256) || !!(await store.stat(sharedSnapshotKey(own.sha256)));
      options.seen?.add(own.sha256);
      result = { ...result, snapshotsShared: 1, freedBytes: duplicate ? own.sizeBytes : 0 };
    }
  }
  if (!bundle || !gate || options.kept.has(bundleKey)) return result;
  const snapshot = await attemptSnapshot(store, directory);
  if (!snapshot) return result;
  if (!options.apply)
    return { ...result, bundlesDeleted: 1, freedBytes: result.freedBytes + bundle.sizeBytes };
  if (!(await bundleRebuilds(store, bundleKey, `${directory}/${GATE_TASK_FILE}`, snapshot.sha256)))
    return { ...result, mismatched: [bundleKey] };
  await store.delete(bundleKey);
  return { ...result, bundlesDeleted: 1, freedBytes: result.freedBytes + bundle.sizeBytes };
}

/** Compacts every compile attempt of one candidate (runs/<run>/verify/<candidate>/...). */
export async function compactCandidate(
  store: ArtifactStore,
  runId: string,
  candidateId: string,
  options: CompactionOptions,
): Promise<Compaction> {
  const entries = await store.list(`runs/${runId}/verify/${candidateId}`);
  const directories = new Set(
    entries
      .filter(({ key }) => key.endsWith(`/${COMPILED_BUNDLE}`) || key.endsWith(`/${SNAPSHOT_FILE}`))
      .map(({ key }) => dirname(key)),
  );
  let total = NOTHING;
  for (const directory of [...directories].sort()) {
    total = add(total, await compactAttempt(store, directory, options));
  }
  return total;
}

/**
 * Whether the gate task plus the snapshot hold exactly the full bundle's files: the same paths,
 * modes and contents, with the snapshot at both of the bundle's snapshot paths.
 */
async function bundleRebuilds(
  store: Pick<ArtifactStore, "openReadByKey">,
  bundleKey: string,
  gateKey: string,
  snapshotSha256: string,
): Promise<boolean> {
  const [full, gate] = [await files(store, bundleKey), await files(store, gateKey)];
  if (!full || !gate) return false;
  const expected = new Map(gate);
  for (const path of SNAPSHOT_PATHS) {
    const entry = full.get(path);
    if (!entry?.endsWith(`:${snapshotSha256}`)) return false;
    expected.set(path, entry);
  }
  if (expected.size !== full.size) return false;
  for (const [path, entry] of full) if (expected.get(path) !== entry) return false;
  return true;
}

/** Each regular file in the archive at `key`, as `<mode>:<sha256>` by path. */
async function files(
  store: Pick<ArtifactStore, "openReadByKey">,
  key: string,
): Promise<Map<string, string> | undefined> {
  const body: Readable | undefined = await store.openReadByKey(key);
  if (!body) return undefined;
  const archive = extract();
  const streaming = pipeline(body, createGunzip(), archive);
  // A stream failure also ends the loop below; it is rethrown by the final await.
  streaming.catch(() => undefined);
  const found = new Map<string, string>();
  for await (const entry of archive) {
    const { name, type, mode = 0 } = entry.header;
    if (type !== "file") {
      entry.resume();
      continue;
    }
    const hash = createHash("sha256");
    for await (const chunk of entry) hash.update(chunk as Buffer);
    found.set(name.replace(/^\.\//, ""), `${(mode & 0o777).toString(8)}:${hash.digest("hex")}`);
  }
  await streaming;
  return found;
}
