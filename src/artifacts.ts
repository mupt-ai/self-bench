import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Storage } from "@google-cloud/storage";
import type { SelfBenchConfig } from "./config.js";
import type { ArtifactRef } from "./contracts.js";
import { sha256 } from "./hash.js";

export interface ArtifactStore {
  put(key: string, value: Uint8Array, contentType: string): Promise<ArtifactRef>;
  putFile(key: string, sourcePath: string, contentType: string): Promise<ArtifactRef>;
  get(reference: ArtifactRef): Promise<Uint8Array>;
  openRead(reference: ArtifactRef): Promise<Readable>;
  getByKey(key: string): Promise<Uint8Array | undefined>;
}

export function createArtifactStore(config: SelfBenchConfig["artifact"]): ArtifactStore {
  return config.kind === "gcs"
    ? new GcsArtifactStore(config.bucket, config.prefix)
    : new LocalArtifactStore(config.directory);
}

export class LocalArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async put(key: string, value: Uint8Array, contentType: string): Promise<ArtifactRef> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const digest = sha256(value);
    try {
      await writeFile(path, value, { flag: "wx" });
    } catch (error) {
      const existing = await fileDigest(path).catch(() => undefined);
      if (!existing || existing.sha256 !== digest || existing.sizeBytes !== value.byteLength) {
        throw error;
      }
    }
    return {
      uri: `file://${path}`,
      sha256: digest,
      sizeBytes: value.byteLength,
      contentType,
    };
  }

  async putFile(key: string, sourcePath: string, contentType: string): Promise<ArtifactRef> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      const digest = await copyWithDigest(sourcePath, temporaryPath);
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
        const existing = await fileDigest(path).catch(() => undefined);
        if (
          !existing ||
          existing.sha256 !== digest.sha256 ||
          existing.sizeBytes !== digest.sizeBytes
        ) {
          throw new Error(`artifact already exists with different contents: file://${path}`);
        }
      }
      return {
        uri: `file://${path}`,
        ...digest,
        contentType,
      };
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async get(reference: ArtifactRef): Promise<Uint8Array> {
    const url = new URL(reference.uri);
    if (url.protocol !== "file:") {
      throw new Error(`local artifact store cannot read ${reference.uri}`);
    }
    const path = resolve(decodeURIComponent(url.pathname));
    this.#assertInsideRoot(path);
    const value = await readFile(path);
    verifyArtifact(reference, value);
    return value;
  }

  async openRead(reference: ArtifactRef): Promise<Readable> {
    const path = this.#pathForReference(reference);
    if ((await stat(path)).size !== reference.sizeBytes) {
      throw new Error(`artifact integrity check failed: ${reference.uri}`);
    }
    return verifiedArtifactReadStream(reference, createReadStream(path));
  }

  async getByKey(key: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.#pathFor(key));
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  #pathForReference(reference: ArtifactRef): string {
    const url = new URL(reference.uri);
    if (url.protocol !== "file:") {
      throw new Error(`local artifact store cannot read ${reference.uri}`);
    }
    const path = resolve(decodeURIComponent(url.pathname));
    this.#assertInsideRoot(path);
    return path;
  }

  #pathFor(key: string): string {
    if (!key || key.startsWith("/") || key.split("/").some((part) => part === "..")) {
      throw new Error(`unsafe artifact key: ${key}`);
    }
    const path = resolve(this.#root, key);
    this.#assertInsideRoot(path);
    return path;
  }

  #assertInsideRoot(path: string): void {
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new Error(`artifact path escapes root: ${path}`);
    }
  }
}

export class GcsArtifactStore implements ArtifactStore {
  readonly #storage = new Storage();
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(bucket: string, prefix: string) {
    this.#bucket = bucket;
    this.#prefix = prefix.replace(/^\/+|\/+$/g, "");
  }

  async put(key: string, value: Uint8Array, contentType: string): Promise<ArtifactRef> {
    const object = this.#objectFor(key);
    const digest = sha256(value);
    const file = this.#storage.bucket(this.#bucket).file(object);
    try {
      await file.save(value, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType,
          metadata: { sha256: digest },
        },
      });
    } catch (error) {
      const [exists] = await file.exists();
      if (!exists) {
        throw error;
      }
      const [metadata] = await file.getMetadata();
      if (metadata.metadata?.sha256 !== digest) {
        throw new Error(
          `artifact already exists with different contents: gs://${this.#bucket}/${object}`,
        );
      }
    }
    return {
      uri: `gs://${this.#bucket}/${object}`,
      sha256: digest,
      sizeBytes: value.byteLength,
      contentType,
    };
  }

  async putFile(key: string, sourcePath: string, contentType: string): Promise<ArtifactRef> {
    const object = this.#objectFor(key);
    const bucket = this.#storage.bucket(this.#bucket);
    const file = bucket.file(object);
    const snapshotDirectory = await mkdtemp(join(tmpdir(), "selfbench-artifact-"));
    const snapshotPath = join(snapshotDirectory, "upload");
    try {
      const digest = await copyWithDigest(sourcePath, snapshotPath);
      try {
        await bucket.upload(snapshotPath, {
          destination: object,
          resumable: true,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType,
            metadata: { sha256: digest.sha256 },
          },
        });
      } catch (error) {
        const [exists] = await file.exists();
        if (!exists) {
          throw error;
        }
        const [metadata] = await file.getMetadata();
        if (
          metadata.metadata?.sha256 !== digest.sha256 ||
          Number(metadata.size) !== digest.sizeBytes
        ) {
          throw new Error(
            `artifact already exists with different contents: gs://${this.#bucket}/${object}`,
          );
        }
      }
      return {
        uri: `gs://${this.#bucket}/${object}`,
        ...digest,
        contentType,
      };
    } finally {
      await rm(snapshotDirectory, { recursive: true, force: true });
    }
  }

  async get(reference: ArtifactRef): Promise<Uint8Array> {
    const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(reference.uri);
    if (!match) {
      throw new Error(`GCS artifact store cannot read ${reference.uri}`);
    }
    const [, bucket, object] = match;
    if (bucket !== this.#bucket || !object) {
      throw new Error(`artifact is outside configured bucket: ${reference.uri}`);
    }
    if (this.#prefix && object !== this.#prefix && !object.startsWith(`${this.#prefix}/`)) {
      throw new Error(`artifact is outside configured bucket: ${reference.uri}`);
    }
    const [value] = await this.#storage.bucket(bucket).file(object).download();
    verifyArtifact(reference, value);
    return value;
  }

  async openRead(reference: ArtifactRef): Promise<Readable> {
    const file = this.#fileForReference(reference);
    const [metadata] = await file.getMetadata();
    if (
      Number(metadata.size) !== reference.sizeBytes ||
      metadata.metadata?.sha256 !== reference.sha256
    ) {
      throw new Error(`artifact integrity check failed: ${reference.uri}`);
    }
    return verifiedArtifactReadStream(reference, file.createReadStream());
  }

  async getByKey(key: string): Promise<Uint8Array | undefined> {
    const file = this.#storage.bucket(this.#bucket).file(this.#objectFor(key));
    const [exists] = await file.exists();
    if (!exists) {
      return undefined;
    }
    const [value] = await file.download();
    return value;
  }

  #fileForReference(reference: ArtifactRef) {
    const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(reference.uri);
    if (!match) {
      throw new Error(`GCS artifact store cannot read ${reference.uri}`);
    }
    const [, bucket, object] = match;
    if (bucket !== this.#bucket || !object) {
      throw new Error(`artifact is outside configured bucket: ${reference.uri}`);
    }
    if (this.#prefix && object !== this.#prefix && !object.startsWith(`${this.#prefix}/`)) {
      throw new Error(`artifact is outside configured bucket: ${reference.uri}`);
    }
    return this.#storage.bucket(bucket).file(object);
  }

  #objectFor(key: string): string {
    if (!key || key.startsWith("/") || key.split("/").some((part) => part === "..")) {
      throw new Error(`unsafe artifact key: ${key}`);
    }
    return this.#prefix ? `${this.#prefix}/${key}` : key;
  }
}

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

async function copyWithDigest(
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
    createWriteStream(destinationPath, { flags: "wx" }),
  );
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function fileDigest(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    sizeBytes += bytes.byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function verifyArtifact(reference: ArtifactRef, value: Uint8Array): void {
  if (value.byteLength !== reference.sizeBytes || sha256(value) !== reference.sha256) {
    throw new Error(`artifact integrity check failed: ${reference.uri}`);
  }
}
