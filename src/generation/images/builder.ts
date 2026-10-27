import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { TaskImageConfig } from "../../contracts/config/task-images.js";
import type { ArtifactRef, TaskImages } from "../../contracts/index.js";
import type { runCommand } from "../../lib/process.js";
import { unpackTask } from "../pipeline/remote-gate.js";
import { cloudBuild } from "./cloud-build.js";
import type { CloudBuildApi } from "./cloud-build-api.js";
import { dockerBuild } from "./docker.js";

/** One compile attempt's images to build. */
export interface ImageBuild {
  readonly runId: string;
  readonly candidateId: string;
  /** The compiled task without its repository snapshot (gate-task.tar.gz). */
  readonly gate: ArtifactRef;
  /** The snapshot both contexts copy as repo.tar.gz. */
  readonly snapshot: ArtifactRef;
  /** The attempt's artifact folder, for what the build needs stored. */
  readonly prefix: string;
}

/** The images by digest, or why the task's own Dockerfile steps failed (the author's to fix). */
type ImageBuildResult = { readonly images: TaskImages } | { readonly failure: string };

/**
 * Builds a task's agent and verifier images into the task image repository before its checks.
 * Infrastructure trouble throws, so Temporal retries the check instead of charging the author.
 */
export interface TaskImageBuilder {
  build(store: ArtifactStore, build: ImageBuild, signal: AbortSignal): Promise<ImageBuildResult>;
}

/** What a builder does with an attempt's unpacked task, under a folder of its own. */
export type BuildFromTask = (
  task: { readonly directory: string; readonly root: string },
  store: ArtifactStore,
  build: ImageBuild,
  signal: AbortSignal,
) => Promise<ImageBuildResult>;

/** The deployment's builder; none when it builds no task images (Harbor builds Dockerfiles). */
export function taskImageBuilder(
  config: TaskImageConfig | undefined,
  /** Stand-ins for Cloud Build's API and the local `docker`, in tests. */
  using: { readonly cloud?: CloudBuildApi; readonly command?: typeof runCommand } = {},
): TaskImageBuilder | undefined {
  const builder = config?.builder;
  if (!config || !builder) return undefined;
  const run =
    builder.kind === "cloud-build"
      ? cloudBuild(config.repository, builder, using.cloud)
      : dockerBuild(config.repository, using.command);
  return {
    async build(store, build, signal) {
      const root = await mkdtemp(join(tmpdir(), "selfbench-images-"));
      try {
        const directory = await unpackTask(store, build.gate, root, signal);
        return await run({ directory, root }, store, build, signal);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
