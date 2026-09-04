import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { LocalTaskSummary, TaskFileEntry, TaskFiles } from "./types.js";

export const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_DEPTH = 4;
const BINARY_SUFFIXES = [".gz", ".tgz", ".tar", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".pdf"];

export function isHarborTaskDirectory(directory: string): Promise<boolean> {
  return lstat(join(directory, "task.toml"))
    .then((stats) => stats.isFile())
    .catch(() => false);
}

export async function scanHarborTasks(root: string): Promise<LocalTaskSummary[]> {
  const base = resolve(root);
  const found: LocalTaskSummary[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (await isHarborTaskDirectory(directory)) {
      found.push(await summarizeTask(base, directory));
      return;
    }
    if (depth >= MAX_SCAN_DEPTH) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
        await visit(join(directory, entry.name), depth + 1);
      }
    }
  };
  await visit(base, 0);
  return found;
}

async function summarizeTask(base: string, directory: string): Promise<LocalTaskSummary> {
  const taskId = taskIdFor(base, directory);
  const toml = await readFile(join(directory, "task.toml"), "utf8").catch(() => "");
  const name = /^name\s*=\s*"([^"]*)"/m.exec(toml)?.[1];
  const difficulty = /^difficulty\s*=\s*"([^"]*)"/m.exec(toml)?.[1];
  const fileCount = (await listFiles(directory)).length;
  return {
    taskId,
    path: relative(base, directory) || ".",
    ...(name ? { name } : {}),
    ...(difficulty ? { difficulty } : {}),
    fileCount,
  };
}

export function taskIdFor(base: string, directory: string): string {
  const path = relative(base, directory);
  if (!path) return basename(base);
  const segments = path.split(sep);
  const last = segments[segments.length - 1];
  if (last === "harbor-task" && segments.length > 1) {
    return segments.slice(0, -1).join("/");
  }
  return segments.join("/");
}

export function resolveTaskDirectory(root: string, taskId: string): string {
  const base = resolve(root);
  if (
    taskId.startsWith("/") ||
    taskId.includes("\\") ||
    taskId.includes("\0") ||
    taskId.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`invalid task id: ${taskId}`);
  }
  if (taskId === basename(base)) return base;
  const directory = resolve(base, taskId);
  if (directory !== base && !directory.startsWith(`${base}${sep}`)) {
    throw new Error(`task escapes root: ${taskId}`);
  }
  return directory;
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

export async function listFiles(directory: string): Promise<string[]> {
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

export function looksLikeText(bytes: Uint8Array): boolean {
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
