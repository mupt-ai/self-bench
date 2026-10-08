import { createHash } from "node:crypto";
import { posix } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { extract, type Headers, pack } from "tar-stream";
import type { ArtifactStore } from "../artifacts/index.js";
import { GATE_TASK_FILE, SNAPSHOT_PATHS } from "../sandbox/gate-bundle.js";

/** The largest archive served; a task without its repository snapshots is far smaller. */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
/** Archives kept in memory, by bundle and folder, least recently used first. */
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
const COMPILED_BUNDLE = "/harbor-task.tar.gz";
const TASK_ROOT = "harbor-task/";

export interface TaskArchive {
  bytes: Buffer;
  /** A strong ETag for `bytes`. */
  etag: string;
}

type Store = Pick<ArtifactStore, "stat" | "openReadByKey">;

const kept = new Map<string, TaskArchive>();
let keptBytes = 0;
const inFlight = new Map<string, Promise<TaskArchive | undefined>>();

/** The archive is too large to serve. */
export class TaskArchiveTooLarge extends Error {}

/**
 * The task at `bundleKey` as a `.tar.gz` a person can download: its Harbor task without the
 * repository snapshots (`environment/repo.tar.gz` and `tests/repo.tar.gz`, each the repository
 * at the task's base commit, tens of MB or more), under `folder/` so that tasks unpack side by
 * side. Read from the gate task beside a compiled bundle when there is one (kilobytes), else
 * from the bundle itself. The same bundle always gives the same bytes. Undefined when no object
 * is at `bundleKey`.
 */
export function taskArchive(
  store: Store,
  bundleKey: string,
  folder: string,
): Promise<TaskArchive | undefined> {
  const id = `${bundleKey}#${folder}`;
  const found = kept.get(id);
  if (found) {
    kept.delete(id);
    kept.set(id, found);
    return Promise.resolve(found);
  }
  const pending = inFlight.get(id);
  if (pending) return pending;
  const promise = build(store, bundleKey, folder)
    .then((archive) => {
      if (archive) remember(id, archive);
      return archive;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

function remember(id: string, archive: TaskArchive): void {
  kept.set(id, archive);
  keptBytes += archive.bytes.length;
  for (const [oldest, entry] of kept) {
    if (keptBytes <= MAX_CACHED_BYTES) break;
    kept.delete(oldest);
    keptBytes -= entry.bytes.length;
  }
}

async function build(
  store: Store,
  bundleKey: string,
  folder: string,
): Promise<TaskArchive | undefined> {
  // The gate task is the compiled bundle without its snapshots (src/sandbox/gate-bundle.ts).
  const gateKey = bundleKey.endsWith(COMPILED_BUNDLE)
    ? `${bundleKey.slice(0, -COMPILED_BUNDLE.length)}/${GATE_TASK_FILE}`
    : undefined;
  const gate = gateKey ? await store.stat(gateKey).catch(() => undefined) : undefined;
  const body = await store.openReadByKey(gate && gateKey ? gateKey : bundleKey);
  if (!body) return undefined;
  const bytes = await repack(body, folder);
  const etag = `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 27)}"`;
  return { bytes, etag };
}

/** The archive's task entries, renamed from `harbor-task/` to `folder/`, snapshots left out. */
async function repack(body: Readable, folder: string): Promise<Buffer> {
  const input = extract();
  const reading = pipeline(body, createGunzip(), input);
  // A failure here also ends the loop below; it is rethrown by the final await.
  reading.catch(() => undefined);
  const output = pack();
  const chunks: Buffer[] = [];
  let size = 0;
  const collect = new PassThrough();
  collect.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES) collect.destroy(new Error("over the size limit"));
    else chunks.push(chunk);
  });
  // No file name or time in the gzip header, so the same entries always give the same bytes.
  const writing = pipeline(output, createGzip(), collect);
  writing.catch(() => undefined);
  const snapshots = new Set<string>(SNAPSHOT_PATHS);
  try {
    await copyEntries(input, output, { folder, snapshots });
    await reading;
    await writing;
  } catch (error) {
    input.destroy();
    if (size > MAX_ARCHIVE_BYTES)
      throw new TaskArchiveTooLarge("task archive is too large to serve");
    throw error;
  }
  return Buffer.concat(chunks);
}

/** Copies the task's entries from `input` into `output`, then finishes `output`. */
async function copyEntries(
  input: ReturnType<typeof extract>,
  output: ReturnType<typeof pack>,
  options: { folder: string; snapshots: ReadonlySet<string> },
): Promise<void> {
  const { folder, snapshots } = options;
  for await (const entry of input) {
    const name = entryPath(entry.header.name);
    const { type } = entry.header;
    if (
      !name.startsWith(TASK_ROOT) ||
      snapshots.has(name) ||
      (type !== "file" && type !== "directory")
    ) {
      entry.resume();
      continue;
    }
    const path = name.slice(TASK_ROOT.length);
    const renamed = `${folder}/${path}`;
    const header: Headers = {
      name: type === "directory" && !renamed.endsWith("/") ? `${renamed}/` : renamed,
      type,
      mode: entry.header.mode,
      mtime: entry.header.mtime,
      size: type === "file" ? entry.header.size : 0,
    };
    await new Promise<void>((resolve, reject) => {
      const sink = output.entry(header, (error) => (error ? reject(error) : resolve()));
      entry.on("error", reject);
      entry.pipe(sink);
    });
  }
  output.finalize();
}

/** An entry's path inside the archive, refusing any that would leave its root. */
function entryPath(name: string): string {
  const path = posix.normalize(name.replace(/^\.\/+/, ""));
  if (!path || path === "." || path.startsWith("/") || path === ".." || path.startsWith("../"))
    throw new Error(`task archive path escapes its root: ${name}`);
  return path;
}
