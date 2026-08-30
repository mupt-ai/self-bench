import { GcsArtifactStore } from "./artifacts/gcs.js";
import { LocalArtifactStore } from "./artifacts/local.js";
import type { ArtifactStore } from "./artifacts/types.js";
import type { SelfBenchConfig } from "./config.js";

export type { ArtifactStore } from "./artifacts/types.js";

export function createArtifactStore(config: SelfBenchConfig["artifact"]): ArtifactStore {
  return config.kind === "gcs"
    ? new GcsArtifactStore(config.bucket, config.prefix)
    : new LocalArtifactStore(config.directory);
}

export { verifiedArtifactReadStream } from "./artifacts/common.js";
export { GcsArtifactStore } from "./artifacts/gcs.js";
export { LocalArtifactStore } from "./artifacts/local.js";
