import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Storage } from "@google-cloud/storage";
import type { SelfBenchConfig } from "./config.js";
import type { ArtifactRef } from "./contracts.js";
import { sha256 } from "./hash.js";

export interface ArtifactStore {
  put(key: string, value: Uint8Array, contentType: string): Promise<ArtifactRef>;
  get(reference: ArtifactRef): Promise<Uint8Array>;
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
      const existing = await readFile(path).catch(() => undefined);
      if (!existing || sha256(existing) !== digest) {
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

  async getByKey(key: string): Promise<Uint8Array | undefined> {
    const file = this.#storage.bucket(this.#bucket).file(this.#objectFor(key));
    const [exists] = await file.exists();
    if (!exists) {
      return undefined;
    }
    const [value] = await file.download();
    return value;
  }

  #objectFor(key: string): string {
    if (!key || key.startsWith("/") || key.split("/").some((part) => part === "..")) {
      throw new Error(`unsafe artifact key: ${key}`);
    }
    return this.#prefix ? `${this.#prefix}/${key}` : key;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function verifyArtifact(reference: ArtifactRef, value: Uint8Array): void {
  if (value.byteLength !== reference.sizeBytes || sha256(value) !== reference.sha256) {
    throw new Error(`artifact integrity check failed: ${reference.uri}`);
  }
}

export async function artifactSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
