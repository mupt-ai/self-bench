import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { HarborEnvironment } from "../../contracts/config/providers.js";
import { isArtifactRegistry } from "../../contracts/config/task-images.js";
import type { TaskImages } from "../../contracts/index.js";
import { isRecord } from "../../lib/util.js";
import {
  proxiedImage,
  REGISTRY_GRANT_TTL_MS,
  REGISTRY_USERNAME,
  repositoryImage,
  signRegistryGrant,
} from "../../sandbox/registry-grant.js";

/** A task's images as one Harbor run pulls them through the API's registry endpoint. */
interface TaskImagePull {
  readonly images: TaskImages;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Readies a Harbor run to pull `images` (in `repository`) through the registry endpoint at
 * `origin` with a grant for exactly those images. The grant reaches the run's provider (an E2B
 * template build), so it is the only credential that leaves.
 */
function taskImagePull(
  images: TaskImages,
  options: { readonly repository: string; readonly origin: string; readonly secret: string },
  now = Date.now(),
): TaskImagePull {
  const named = [images.agent, images.verifier].map((image) =>
    repositoryImage(options.repository, image),
  );
  const password = signRegistryGrant(
    { images: named, expiresAt: now + REGISTRY_GRANT_TTL_MS },
    options.secret,
  );
  const host = new URL(options.origin).host;
  const [agent, verifier] = named.map((image) => proxiedImage(options.origin, image));
  if (!agent || !verifier) throw new Error("a task image pull needs both images");
  return {
    images: { agent, verifier },
    env: {
      SELFBENCH_REGISTRY_HOST: host,
      SELFBENCH_REGISTRY_USERNAME: REGISTRY_USERNAME,
      SELFBENCH_REGISTRY_PASSWORD: password,
    },
  };
}

/**
 * Points the task's agent environment (and its separate verifier's) at the pulled images, so
 * Harbor starts from them instead of building the Dockerfiles. Runs after the task-safety check,
 * which refuses any `docker_image` a bundle sets itself.
 */
async function applyTaskImages(taskDirectory: string, images: TaskImages): Promise<void> {
  const path = join(taskDirectory, "task.toml");
  const config = parse(await readFile(path, "utf8"));
  config.environment = {
    ...(isRecord(config.environment) ? config.environment : {}),
    docker_image: images.agent,
  };
  const verifier = isRecord(config.verifier) ? config.verifier : {};
  config.verifier = {
    ...verifier,
    environment: {
      ...(isRecord(verifier.environment) ? verifier.environment : {}),
      docker_image: images.verifier,
    },
  };
  await writeFile(path, stringify(config));
  // Compose builds `main` from the context's Dockerfile rather than `docker_image`, so a service
  // context starts FROM the proxied image the run's login covers, not the registry it lives in.
  for (const [context, image] of [
    ["environment", images.agent],
    ["tests", images.verifier],
  ] as const) {
    const composed = await readFile(join(taskDirectory, context, "docker-compose.yaml")).then(
      () => true,
      () => false,
    );
    if (composed) await writeFile(join(taskDirectory, context, "Dockerfile"), `FROM ${image}\n`);
  }
}

/**
 * Starts a checked task (a trial, its image preparation, or a generation check) from the task's
 * images instead of its Dockerfiles. Docker pulls them straight from the repository, with the
 * host's own registry login. Every other provider pulls through the API's registry endpoint with a
 * grant for exactly these two images (the only credential that leaves), which needs the repository
 * in Artifact Registry and the sandbox callback's origin and secret. Returns the variables the
 * Harbor process needs for the pull; none for a task without images, which builds its Dockerfiles.
 */
export async function startFromTaskImages(
  taskDirectory: string,
  images: TaskImages | undefined,
  environment: HarborEnvironment,
  serving: { readonly env: NodeJS.ProcessEnv; readonly callback?: { url: string; secret: string } },
): Promise<Readonly<Record<string, string>>> {
  if (!images) return {};
  if (environment === "docker") {
    await applyTaskImages(taskDirectory, images);
    return {};
  }
  const repository = serving.env.SELFBENCH_TASK_IMAGE_REPOSITORY;
  const { callback } = serving;
  if (!repository || !isArtifactRegistry(repository) || !callback)
    throw new Error(
      `${environment} pulls task images through the API, which needs an Artifact Registry SELFBENCH_TASK_IMAGE_REPOSITORY and the sandbox callback`,
    );
  const pull = taskImagePull(images, {
    repository,
    origin: callback.url,
    secret: callback.secret,
  });
  await applyTaskImages(taskDirectory, pull.images);
  return pull.env;
}
