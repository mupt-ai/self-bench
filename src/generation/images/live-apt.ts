import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarborEnvironment } from "../../contracts/config/providers.js";
import { taskImageConfig, taskImageEnvironmentSchema } from "../../contracts/config/task-images.js";
import type { TaskImages } from "../../contracts/index.js";
import { LIVE_APT_SOURCES, pinsAptSnapshot } from "../task/live-apt.js";
import { type CloudBuildApi, googleCloudBuild } from "./cloud-build-api.js";
import { IMAGE_CONTEXTS } from "./contexts.js";
import { type RegistryAccess, taggedDigest } from "./registry.js";

const DOCKER = "gcr.io/cloud-builders/docker";
/** Pulling a large task image and pushing its one new layer. */
const BUILD_TIMEOUT = "1800s";

interface LiveAptDeps {
  readonly cloud?: CloudBuildApi;
  readonly registry?: RegistryAccess;
}

/**
 * A task's images as E2B can make templates from them: an image whose Dockerfile left apt on a
 * dated snapshot (src/generation/task/live-apt.ts) is replaced by one with apt back on the live
 * mirrors, built once on Cloud Build next to it and found again by its tag. Tasks compiled since
 * do this in their own images; other providers make no templates, and a deployment without Cloud
 * Build keeps the images it has.
 */
export async function withLiveApt(
  taskDirectory: string,
  images: TaskImages | undefined,
  environment: HarborEnvironment,
  env: NodeJS.ProcessEnv,
  deps: LiveAptDeps = {},
): Promise<TaskImages | undefined> {
  if (!images || environment !== "e2b") return images;
  const config = taskImageConfig(taskImageEnvironmentSchema.parse(env));
  if (config?.builder?.kind !== "cloud-build") return images;
  const builder = config.builder;
  const live = { ...images };
  for (const { role, context } of IMAGE_CONTEXTS) {
    const dockerfile = await readFile(join(taskDirectory, context, "Dockerfile"), "utf8").catch(
      () => "",
    );
    // Tasks compiled since restore the mirrors in their own images.
    if (!pinsAptSnapshot(dockerfile) || dockerfile.includes(LIVE_APT_SOURCES)) continue;
    live[role] = await liveAptImage(images[role], {
      cloud: deps.cloud ?? googleCloudBuild(builder),
      ...(deps.registry ? { registry: deps.registry } : {}),
    });
  }
  return live;
}

/**
 * `image` (`<name>@sha256:<digest>`) with apt on its live mirrors: `<name>-live-apt`, tagged by
 * the digest it was built from. Task repositories keep tags immutable, so of two builds that
 * evaluations start together the first to push names the image, and the other uses it.
 */
async function liveAptImage(
  image: string,
  deps: { readonly cloud: CloudBuildApi; readonly registry?: RegistryAccess },
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const [name, digest] = image.split("@");
  if (!name || !digest?.startsWith("sha256:"))
    throw new Error(`${image} is not an image by digest`);
  const target = `${name}-live-apt`;
  const tag = `from-${digest.slice("sha256:".length)}`;
  const existing = await taggedDigest(target, tag, deps.registry);
  if (existing) return `${target}@${existing}`;
  const script = [
    "set -euo pipefail",
    "cat > /workspace/Dockerfile <<'DOCKERFILE'",
    `FROM ${image}`,
    "USER root",
    `RUN ${LIVE_APT_SOURCES}`,
    "DOCKERFILE",
    `docker build -t ${target}:${tag} /workspace`,
    `docker push ${target}:${tag}`,
    `docker inspect --format '{{index .RepoDigests 0}}' ${target}:${tag} | cut -d@ -f2 > "$BUILDER_OUTPUT/output"`,
  ].join("\n");
  const finished = await deps.cloud.run(
    {
      // Cloud Build substitutes `$NAME` in a build's strings; `$$` is a literal `$`.
      steps: [
        {
          id: "live-apt",
          name: DOCKER,
          entrypoint: "bash",
          args: ["-c", script.replace(/\$/g, "$$$$")],
        },
      ],
      timeout: BUILD_TIMEOUT,
      tags: ["selfbench-live-apt"],
    },
    signal,
  );
  const built = Buffer.from(finished.results?.buildStepOutputs?.[0] ?? "", "base64")
    .toString("utf8")
    .trim();
  if (finished.status !== "SUCCESS" || !/^sha256:[0-9a-f]{64}$/.test(built)) {
    const pushed = await taggedDigest(target, tag, deps.registry);
    if (pushed) return `${target}@${pushed}`;
    throw new Error(
      `Cloud Build ${finished.id} could not point ${image} at apt's live mirrors (${finished.status})`,
    );
  }
  return `${target}@${built}`;
}
