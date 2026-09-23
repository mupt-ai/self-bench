import type { Readable } from "node:stream";
import type { ArtifactRef } from "../contracts/index.js";
import type { ArtifactEntry } from "../generation/runs/types.js";

export type { ArtifactEntry };

export interface ArtifactStore {
  put(key: string, value: Uint8Array, contentType: string): Promise<ArtifactRef>;
  putFile(key: string, sourcePath: string, contentType: string): Promise<ArtifactRef>;
  get(reference: ArtifactRef): Promise<Uint8Array>;
  openRead(reference: ArtifactRef): Promise<Readable>;
  getByKey(key: string): Promise<Uint8Array | undefined>;
  /** A time-limited URL a sandbox can GET the artifact from, when the backend supports it. */
  signedReadUrl?(reference: ArtifactRef, ttlMs: number): Promise<string | undefined>;
  /**
   * A time-limited URL a sandbox can PUT one new object to, with the headers it must send. The
   * object can be created only once and records the declared SHA-256, which reads verify.
   */
  signedWriteUrl?(key: string, upload: ArtifactUpload, ttlMs: number): Promise<SignedUpload>;
  /** Where the object at `key` is and what it holds; undefined when it does not exist. */
  stat(key: string): Promise<Omit<ArtifactRef, "contentType"> | undefined>;
  openReadByKey(key: string, options?: { readonly start?: number }): Promise<Readable | undefined>;
  list(prefix: string): Promise<ArtifactEntry[]>;
}

export interface ArtifactUpload {
  readonly sha256: string;
  readonly contentType: string;
}

export interface SignedUpload {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}
