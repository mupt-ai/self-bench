import type { Readable } from "node:stream";
import type { ArtifactRef } from "../contracts.js";

export interface ArtifactStore {
  put(key: string, value: Uint8Array, contentType: string): Promise<ArtifactRef>;
  putFile(key: string, sourcePath: string, contentType: string): Promise<ArtifactRef>;
  get(reference: ArtifactRef): Promise<Uint8Array>;
  openRead(reference: ArtifactRef): Promise<Readable>;
  getByKey(key: string): Promise<Uint8Array | undefined>;
  /** A time-limited URL a sandbox can GET the artifact from, when the backend supports it. */
  signedReadUrl?(reference: ArtifactRef, ttlMs: number): Promise<string | undefined>;
}
