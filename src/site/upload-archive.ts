import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gzipSync } from "node:zlib";
import { extract, pack } from "tar-stream";

export const UPLOAD_LIMITS = {
  compressed: 32 * 1024 * 1024,
  expanded: 128 * 1024 * 1024,
  entries: 5000,
  tasks: 200,
};
export interface ArchiveBudget {
  bytes: number;
  entries: number;
}
export class UploadError extends Error {}

/** Parse into memory, never extract to disk or execute anything. Budget includes nested wrappers. */
export async function readUploadArchive(
  bytes: Buffer,
  budget: ArchiveBudget,
): Promise<Map<string, Buffer>> {
  if (!bytes.length || bytes.length > UPLOAD_LIMITS.compressed)
    throw new UploadError("Archive exceeds 32 MiB compressed limit or is empty");
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  const parser = extract();
  parser.on("entry", (header, stream, next) => {
    void (async () => {
      budget.entries++;
      if (budget.entries > UPLOAD_LIMITS.entries) throw new UploadError("Too many archive entries");
      const raw = header.name;
      if (
        /^[/\\]/.test(raw) ||
        raw.includes("\\") ||
        [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        raw.split("/").includes("..") ||
        /^[a-z]:/i.test(raw)
      )
        throw new UploadError("Unsafe archive path");
      const path = raw
        .split("/")
        .filter((part) => part && part !== ".")
        .join("/");
      if (path.length > 512 || path.split("/").length > 32)
        throw new UploadError("Archive path too long or deep");
      if (header.type !== "file" && header.type !== "directory")
        throw new UploadError("Links and special archive entries are not allowed");
      if (!path && header.type === "directory") {
        stream.resume();
        next();
        return;
      }
      if (!path || seen.has(path)) throw new UploadError("Repeated archive path");
      seen.add(path);
      if (!Number.isSafeInteger(header.size) || (header.size ?? 0) > UPLOAD_LIMITS.expanded)
        throw new UploadError("Invalid archive entry size");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      if (header.type === "file") files.set(path, Buffer.concat(chunks));
      next();
    })().catch((error: Error) => parser.destroy(error));
  });
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      budget.bytes += chunk.length;
      callback(
        budget.bytes > UPLOAD_LIMITS.expanded
          ? new UploadError("Archive exceeds 128 MiB expanded limit")
          : null,
        chunk,
      );
    },
  });
  try {
    const source = Readable.from([bytes]);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b)
      await pipeline(source, createGunzip(), limiter, parser);
    else await pipeline(source, limiter, parser);
  } catch (error) {
    throw error instanceof UploadError
      ? error
      : new UploadError("Malformed or truncated tar archive");
  }
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (files.has(parts.slice(0, i).join("/")))
        throw new UploadError("File/directory path collision");
  }
  if (!files.size) throw new UploadError("Archive contains no files");
  return files;
}

/** Repackage only validated regular files under the viewer's known Harbor root. */
export async function packageUpload(files: Map<string, Buffer>): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  const consumed = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  })();
  for (const [path, data] of files)
    archive.entry(
      {
        name: `harbor-task/${path}`,
        size: data.length,
        mode: path.endsWith(".sh") ? 0o755 : 0o644,
        mtime: new Date(0),
      },
      data,
    );
  archive.finalize();
  await consumed;
  return gzipSync(Buffer.concat(chunks));
}
