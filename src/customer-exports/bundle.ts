import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import type { ArtifactStore } from "../artifacts/index.js";

/** Full execution files, not the viewer's truncated text projection. Nothing is extracted to disk. */
export async function readExecutionBundle(
  store: ArtifactStore,
  key: string,
): Promise<Map<string, string>> {
  const body = await store.openReadByKey(key);
  if (!body) throw new Error("Execution bundle is missing");
  const archive = extract();
  const reading = pipeline(body, createGunzip(), archive);
  reading.catch(() => undefined);
  const files = new Map<string, string>();
  let total = 0;
  try {
    for await (const entry of archive) {
      if (entry.header.type !== "file") {
        entry.resume();
        continue;
      }
      const name = entry.header.name.replace(/^\.\//, "");
      if (!name.startsWith("harbor-task/")) throw new Error("Unexpected execution bundle root");
      const path = name.slice("harbor-task/".length);
      if (files.has(path)) throw new Error("Duplicate execution bundle path");
      if ((entry.header.size ?? 0) > 32 * 1024 * 1024 - total)
        throw new Error("Execution task files exceed 32 MiB");
      const chunks: Buffer[] = [];
      for await (const chunk of entry) {
        total += chunk.length;
        if (total > 32 * 1024 * 1024) throw new Error("Execution task files exceed 32 MiB");
        chunks.push(Buffer.from(chunk));
      }
      files.set(path, Buffer.concat(chunks).toString("utf8"));
    }
    await reading;
    return files;
  } catch (error) {
    archive.destroy();
    body.destroy();
    throw error;
  }
}
