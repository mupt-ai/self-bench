import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { HarborEnvironment } from "../../contracts/config/providers.js";
import { taskImageConfig } from "../../contracts/config/task-images.js";
import type { TaskImages } from "../../contracts/index.js";
import { isRecord } from "../../lib/util.js";
import {
  proxiedImage,
  REGISTRY_GRANT_TTL_MS,
  REGISTRY_USERNAME,
  repositoryImage,
  signRegistryGrant,
} from "../../sandbox/registry-grant.js";

/**
 * Harbor environments that start from a task's exported image with SelfBench's pull grant:
 * runtime/selfbench_e2b.py, and Docker through DOCKER_CONFIG. Modal starts from the task's own
 * Modal images; the others build the task's Dockerfiles as before.
 */
const PULLING_ENVIRONMENTS: ReadonlySet<HarborEnvironment> = new Set(["e2b", "docker"]);

function pullsTaskImages(environment: HarborEnvironment): boolean {
  return PULLING_ENVIRONMENTS.has(environment);
}

/** A task's images as one Harbor run pulls them through the API's registry endpoint. */
interface TaskImagePull {
  readonly images: { readonly agent: string; readonly verifier?: string };
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Readies a Harbor run under `root` to pull `images` (in `repository`) through the registry
 * endpoint at `origin` with a grant for exactly those images. The grant reaches the run's
 * provider (an E2B template build), so it is the only credential that leaves.
 */
async function taskImagePull(
  images: { readonly agent: string; readonly verifier?: string | undefined },
  options: { readonly repository: string; readonly origin: string; readonly secret: string },
  root: string,
  now = Date.now(),
): Promise<TaskImagePull> {
  const named = [images.agent, ...(images.verifier ? [images.verifier] : [])].map((image) =>
    repositoryImage(options.repository, image),
  );
  const password = signRegistryGrant(
    { images: named, expiresAt: now + REGISTRY_GRANT_TTL_MS },
    options.secret,
  );
  const host = new URL(options.origin).host;
  // Harbor's Docker environment pulls with the docker CLI, which reads its login from here.
  const dockerConfig = join(root, "docker-config");
  await mkdir(dockerConfig, { recursive: true, mode: 0o700 });
  const auth = Buffer.from(`${REGISTRY_USERNAME}:${password}`).toString("base64");
  await writeFile(
    join(dockerConfig, "config.json"),
    JSON.stringify({ auths: { [host]: { auth } } }),
    { mode: 0o600 },
  );
  const [agent, verifier] = named.map((image) => proxiedImage(options.origin, image));
  if (!agent) throw new Error("a task image pull needs an agent image");
  return {
    images: { agent, ...(images.verifier && verifier ? { verifier } : {}) },
    env: {
      SELFBENCH_REGISTRY_HOST: host,
      SELFBENCH_REGISTRY_USERNAME: REGISTRY_USERNAME,
      SELFBENCH_REGISTRY_PASSWORD: password,
      DOCKER_CONFIG: dockerConfig,
    },
  };
}

/**
 * Points the task's agent environment (and its separate verifier's) at the pulled images, so
 * Harbor starts from them instead of building the Dockerfiles. Runs after the task-safety check,
 * which refuses any `docker_image` a bundle sets itself.
 */
async function applyTaskImages(taskDirectory: string, pull: TaskImagePull): Promise<void> {
  const path = join(taskDirectory, "task.toml");
  const config = parse(await readFile(path, "utf8"));
  config.environment = {
    ...(isRecord(config.environment) ? config.environment : {}),
    docker_image: pull.images.agent,
  };
  if (pull.images.verifier) {
    const verifier = isRecord(config.verifier) ? config.verifier : {};
    config.verifier = {
      ...verifier,
      environment: {
        ...(isRecord(verifier.environment) ? verifier.environment : {}),
        docker_image: pull.images.verifier,
      },
    };
  }
  await writeFile(path, stringify(config));
}

/**
 * Starts a checked trial task (or its image preparation) from the task's exported images when
 * its provider pulls them and this worker serves a task image repository (its environment names
 * one, and pull grants are signed with the sandbox callback's secret). Returns the variables the
 * Harbor process needs for the pull; none when the task builds its Dockerfiles as before.
 */
export async function startFromExportedImages(
  taskDirectory: string,
  images: TaskImages | undefined,
  environment: HarborEnvironment,
  serving: { readonly env: NodeJS.ProcessEnv; readonly callback?: { url: string; secret: string } },
  root: string,
): Promise<Readonly<Record<string, string>>> {
  const repository = taskImageConfig({
    SELFBENCH_TASK_IMAGE_REPOSITORY: serving.env.SELFBENCH_TASK_IMAGE_REPOSITORY,
  })?.repository;
  const { callback } = serving;
  if (!images?.registry || !pullsTaskImages(environment) || !repository || !callback) return {};
  const pull = await taskImagePull(
    images.registry,
    { repository, origin: callback.url, secret: callback.secret },
    root,
  );
  await applyTaskImages(taskDirectory, pull);
  return pull.env;
}
