import { lstat, readdir, readlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { runCommand } from "./process.js";

const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_UNPACKED_BYTES = 10 * 1024 * 1024 * 1024;

export async function extractRegularArchive(
  archive: string,
  destination: string,
  options: { readonly allowSymlinks?: boolean; readonly signal?: AbortSignal } = {},
): Promise<void> {
  const [names, verbose] = await Promise.all([
    runCommand("tar", ["-tzf", archive], options.signal ? { signal: options.signal } : {}),
    runCommand("tar", ["-tvzf", archive], options.signal ? { signal: options.signal } : {}),
  ]);
  const paths = outputLines(names.stdout);
  const entries = outputLines(verbose.stdout);
  if (paths.length !== entries.length) {
    throw new Error("archive listing is ambiguous");
  }
  if (paths.length === 0 || paths.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`archive must contain between 1 and ${MAX_ARCHIVE_ENTRIES} entries`);
  }

  const normalized = new Set<string>();
  const symlinks = new Set<string>();
  let unpackedBytes = 0;
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const entry = entries[index];
    const allowedTypes = options.allowSymlinks ? ["-", "d", "l"] : ["-", "d"];
    if (!path || !entry || !allowedTypes.includes(entry[0] ?? "")) {
      throw new Error(`archive contains an unsupported entry: ${path ?? "unknown"}`);
    }
    unpackedBytes += archiveEntrySize(entry);
    if (unpackedBytes > MAX_ARCHIVE_UNPACKED_BYTES) {
      throw new Error(`archive expands beyond ${MAX_ARCHIVE_UNPACKED_BYTES} bytes`);
    }
    const safePath = normalizeArchivePath(path);
    if (normalized.has(safePath)) {
      throw new Error(`archive repeats path ${safePath}`);
    }
    if ([...symlinks].some((link) => safePath.startsWith(`${link}/`))) {
      throw new Error(`archive writes through symbolic link ${safePath}`);
    }
    if (entry[0] === "l") {
      if ([...normalized].some((existing) => existing.startsWith(`${safePath}/`))) {
        throw new Error(`archive replaces a directory with symbolic link ${safePath}`);
      }
      validateLinkTarget(safePath, verboseLinkTarget(entry, safePath));
      symlinks.add(safePath);
    }
    normalized.add(safePath);
  }

  await runCommand(
    "tar",
    ["-xzf", archive, "--no-same-owner", "-C", destination],
    options.signal ? { signal: options.signal } : {},
  );
  await assertExtractedTreeIsRegular(destination, options.allowSymlinks ?? false);
}

function normalizeArchivePath(path: string): string {
  if (path.includes("\0") || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`archive path escapes destination: ${path}`);
  }
  const normalized = posix.normalize(path.replace(/^\.\/+/, ""));
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`archive path escapes destination: ${path}`);
  }
  return normalized;
}

async function assertExtractedTreeIsRegular(root: string, allowSymlinks: boolean): Promise<void> {
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() && allowSymlinks) {
      const relative = posix.relative(root, path);
      validateLinkTarget(relative, await readlink(path));
      continue;
    }
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new Error(`archive extracted an unsupported entry: ${entry.name}`);
    }
  }
}

function archiveEntrySize(entry: string): number {
  const fields = entry.trim().split(/\s+/);
  const index = /^\d+$/.test(fields[1] ?? "") ? 4 : 2;
  const size = Number(fields[index]);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("archive entry has an invalid size");
  }
  return size;
}

function verboseLinkTarget(entry: string, path: string): string {
  const separator = entry.lastIndexOf(" -> ");
  if (separator < 0) {
    throw new Error(`archive symbolic link has no target: ${path}`);
  }
  return entry.slice(separator + 4);
}

function validateLinkTarget(path: string, target: string): void {
  const resolved = posix.resolve("/archive", posix.dirname(path), target);
  if (target.startsWith("/") || (resolved !== "/archive" && !resolved.startsWith("/archive/"))) {
    throw new Error(`archive symbolic link escapes destination: ${path} -> ${target}`);
  }
}

function outputLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}
