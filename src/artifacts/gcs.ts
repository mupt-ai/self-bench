import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Storage } from "@google-cloud/storage";
import type { ArtifactRef } from "../contracts.js";
import { sha256 } from "../hash.js";
import { copyWithDigest, verifiedArtifactReadStream, verifyArtifact } from "./common.js";
import type { ArtifactEntry, ArtifactStore } from "./types.js";

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

  async signedReadUrl(reference: ArtifactRef, ttlMs: number): Promise<string> {
    const [url] = await this.#fileForReference(reference).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + ttlMs,
    });
    return url;
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

  async openReadByKey(
    key: string,
    options: { readonly start?: number } = {},
  ): Promise<Readable | undefined> {
    const file = this.#storage.bucket(this.#bucket).file(this.#objectFor(key));
    const [exists] = await file.exists();
    if (!exists) {
      return undefined;
    }
    return file.createReadStream(options.start ? { start: options.start } : {});
  }

  async list(prefix: string): Promise<ArtifactEntry[]> {
    const object = this.#objectFor(prefix);
    const [files] = await this.#storage.bucket(this.#bucket).getFiles({ prefix: `${object}/` });
    const base = this.#prefix ? `${this.#prefix}/` : "";
    const entries: ArtifactEntry[] = [];
    for (const file of files) {
      if (!file.name.startsWith(base) || file.name.endsWith("/")) continue;
      const updated = file.metadata.updated;
      entries.push({
        key: file.name.slice(base.length),
        sizeBytes: Number(file.metadata.size ?? 0),
        ...(updated ? { updatedAt: String(updated) } : {}),
      });
    }
    return entries.sort((left, right) => left.key.localeCompare(right.key));
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
    if (
      !key ||
      key.startsWith("/") ||
      key.includes("\\") ||
      key.includes("\0") ||
      key.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`unsafe artifact key: ${key}`);
    }
    return this.#prefix ? `${this.#prefix}/${key}` : key;
  }
}
