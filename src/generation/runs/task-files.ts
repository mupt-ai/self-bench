import type { TaskFileEntry, TaskFiles } from "./types.js";

const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
const BINARY_SUFFIXES = [".gz", ".tgz", ".tar", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".pdf"];

/** A regular file from a task bundle; `bytes` is present only when worth inlining. */
export interface BundleFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly bytes?: Uint8Array;
}

/** Whether the viewer may show this file inline, decided before reading its contents. */
export function isInlineCandidate(path: string, sizeBytes: number): boolean {
  return sizeBytes <= MAX_INLINE_TEXT_BYTES && !hasBinarySuffix(path);
}

/** Viewer files for a bundle, rooted at `harbor-task/` when the bundle wraps the task in it. */
export function taskFilesFromBundle(files: readonly BundleFile[], taskId: string): TaskFiles {
  const prefix = files.some((file) => file.path === "harbor-task/task.toml") ? "harbor-task/" : "";
  const entries: TaskFileEntry[] = files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
    .sort((left, right) => comparePaths(left.path, right.path))
    .map(({ path, sizeBytes, bytes }) =>
      bytes && looksLikeText(bytes)
        ? { path, sizeBytes, text: Buffer.from(bytes).toString("utf8") }
        : { path, sizeBytes },
    );
  return { taskId, files: entries };
}

// Directory by directory, as a recursive listing sorted per level would order them.
function comparePaths(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = (a[index] ?? "").localeCompare(b[index] ?? "");
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function hasBinarySuffix(path: string): boolean {
  const lower = path.toLowerCase();
  return BINARY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
