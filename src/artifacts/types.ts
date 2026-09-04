import type { Readable } from "node:stream";
import type { ArtifactRef } from "../contracts.js";
import type { ArtifactEntry } from "../viewer/types.js";

export type { ArtifactEntry };

export interface ArtifactStore {
  put(key: string, value: Uint8Array, contentType: string): Promise<ArtifactRef>;
  putFile(key: string, sourcePath: string, contentType: string): Promise<ArtifactRef>;
  get(reference: ArtifactRef): Promise<Uint8Array>;
  openRead(reference: ArtifactRef): Promise<Readable>;
  getByKey(key: string): Promise<Uint8Array | undefined>;
  openReadByKey(key: string, options?: { readonly start?: number }): Promise<Readable | undefined>;
  list(prefix: string): Promise<ArtifactEntry[]>;
}
