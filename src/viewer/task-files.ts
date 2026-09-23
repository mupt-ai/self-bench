import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskFileEntry, TaskFiles } from "./types.js";

const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
const BINARY_SUFFIXES = [".gz", ".tgz", ".tar", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".pdf"];

export function isHarborTaskDirectory(directory: string): Promise<boolean> {
  return lstat(join(directory, "task.toml"))
    .then((stats) => stats.isFile())
    .catch(() => false);
}

export async function readTaskDirectory(directory: string, taskId: string): Promise<TaskFiles> {
  const files: TaskFileEntry[] = [];
  for (const path of await listFiles(directory)) {
    const absolute = join(directory, path);
    const stats = await lstat(absolute);
    const entry: TaskFileEntry = { path, sizeBytes: stats.size };
    if (stats.size <= MAX_INLINE_TEXT_BYTES && !hasBinarySuffix(path)) {
      const bytes = await readFile(absolute);
      if (looksLikeText(bytes)) {
        files.push({ ...entry, text: bytes.toString("utf8") });
        continue;
      }
    }
    files.push(entry);
  }
  return { taskId, files };
}

async function listFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(join(current, entry.name), path);
      } else if (entry.isFile()) {
        output.push(path);
      }
    }
  };
  await visit(directory, "");
  return output;
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
