import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactRef } from "../contracts.js";
import { sha256 } from "../hash.js";

export function verifiedArtifactReadStream(reference: ArtifactRef, input: Readable): Readable {
  return Readable.from(
    (async function* () {
      const hash = createHash("sha256");
      let sizeBytes = 0;
      for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        sizeBytes += bytes.byteLength;
        yield bytes;
      }
      if (sizeBytes !== reference.sizeBytes || hash.digest("hex") !== reference.sha256) {
        throw new Error(`artifact integrity check failed: ${reference.uri}`);
      }
    })(),
  );
}

export async function copyWithDigest(
  sourcePath: string,
  destinationPath: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      sizeBytes += chunk.byteLength;
      callback(undefined, chunk);
    },
  });
  await pipeline(
    createReadStream(sourcePath),
    hasher,
    createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
  );
  return { sha256: hash.digest("hex"), sizeBytes };
}

export async function fileDigest(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    sizeBytes += bytes.byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

export function verifyArtifact(reference: ArtifactRef, value: Uint8Array): void {
  if (value.byteLength !== reference.sizeBytes || sha256(value) !== reference.sha256) {
    throw new Error(`artifact integrity check failed: ${reference.uri}`);
  }
}
