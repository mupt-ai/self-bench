import { z } from "zod";
import { fail } from "../../lib/util.js";

const emptyStringAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optional = z.preprocess(emptyStringAsUndefined, z.string().trim().optional());

export const taskImageEnvironmentSchema = z.object({
  // Where every task's images live, by digest; the API serves pulls from it.
  SELFBENCH_TASK_IMAGE_REPOSITORY: optional,
  // What builds them before a task's checks: Google Cloud Build, or the worker's own Docker.
  SELFBENCH_TASK_IMAGE_BUILDER: z.preprocess(
    emptyStringAsUndefined,
    z.enum(["cloud-build", "docker"]).optional(),
  ),
  // A repository with mutable tags for the builds' layer cache.
  SELFBENCH_TASK_IMAGE_CACHE: optional,
  // An Artifact Registry remote repository of Docker Hub, which builds pull base images through.
  SELFBENCH_DOCKER_HUB_MIRROR: optional,
  // Cloud Build's own identity, and the bucket its logs go to.
  SELFBENCH_CLOUD_BUILD_SERVICE_ACCOUNT: optional,
  SELFBENCH_CLOUD_BUILD_LOGS_BUCKET: optional,
});

type CloudBuild = {
  readonly kind: "cloud-build";
  readonly project: string;
  readonly region: string;
  readonly serviceAccount: string;
  readonly logsBucket: string;
  readonly mirror?: string;
};

/** How task images are built; without a builder, Harbor builds a task's Dockerfiles itself. */
export type TaskImageBuilderConfig = (CloudBuild | { readonly kind: "docker" }) & {
  readonly cache?: string;
};

export interface TaskImageConfig {
  /** `<region>-docker.pkg.dev/<project>/<repository>`, or any registry the Docker builder pushes to. */
  readonly repository: string;
  readonly builder?: TaskImageBuilderConfig;
}

const ARTIFACT_REGISTRY = /^([a-z0-9-]+)-docker\.pkg\.dev\/([a-z0-9-]+)\/[a-z0-9._-]+$/;

/** Whether a repository is in Artifact Registry, which the API can serve pulls from. */
export function isArtifactRegistry(repository: string): boolean {
  return ARTIFACT_REGISTRY.test(repository);
}

export function taskImageConfig(
  value: z.infer<typeof taskImageEnvironmentSchema>,
): TaskImageConfig | undefined {
  const repository = value.SELFBENCH_TASK_IMAGE_REPOSITORY;
  const kind = value.SELFBENCH_TASK_IMAGE_BUILDER;
  if (!repository) {
    if (kind) fail("SELFBENCH_TASK_IMAGE_BUILDER needs SELFBENCH_TASK_IMAGE_REPOSITORY");
    return undefined;
  }
  const cache = value.SELFBENCH_TASK_IMAGE_CACHE ? { cache: value.SELFBENCH_TASK_IMAGE_CACHE } : {};
  if (kind === "docker") return { repository, builder: { kind, ...cache } };
  const registry = ARTIFACT_REGISTRY.exec(repository);
  if (!registry?.[1] || !registry[2])
    fail("SELFBENCH_TASK_IMAGE_REPOSITORY must be <region>-docker.pkg.dev/<project>/<repository>");
  if (!kind) return { repository };
  const serviceAccount = value.SELFBENCH_CLOUD_BUILD_SERVICE_ACCOUNT;
  const logsBucket = value.SELFBENCH_CLOUD_BUILD_LOGS_BUCKET;
  if (!serviceAccount || !logsBucket)
    fail(
      "Cloud Build needs SELFBENCH_CLOUD_BUILD_SERVICE_ACCOUNT and SELFBENCH_CLOUD_BUILD_LOGS_BUCKET",
    );
  return {
    repository,
    builder: {
      kind,
      project: registry[2],
      region: registry[1],
      serviceAccount,
      logsBucket,
      ...(value.SELFBENCH_DOCKER_HUB_MIRROR ? { mirror: value.SELFBENCH_DOCKER_HUB_MIRROR } : {}),
      ...cache,
    },
  };
}
