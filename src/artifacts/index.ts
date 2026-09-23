import type { SelfBenchConfig } from "../config/index.js";
import { GcsArtifactStore } from "./gcs.js";
import { LocalArtifactStore } from "./local.js";
import type { ArtifactStore } from "./types.js";

export type { ArtifactStore } from "./types.js";

export function createArtifactStore(config: SelfBenchConfig["artifact"]): ArtifactStore {
  return config.kind === "gcs"
    ? new GcsArtifactStore(config.bucket, config.prefix)
    : new LocalArtifactStore(config.directory);
}

export { verifiedArtifactReadStream } from "./common.js";
export { GcsArtifactStore } from "./gcs.js";
export { LocalArtifactStore } from "./local.js";
