import { z } from "zod";
import { fail } from "../../lib/util.js";

const emptyStringAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const taskImageEnvironmentSchema = z.object({
  // Artifact Registry repository accepted tasks' images are exported to and pulled from.
  SELFBENCH_TASK_IMAGE_REPOSITORY: z.preprocess(emptyStringAsUndefined, z.string().optional()),
});

/**
 * SelfBench's task image repository in Artifact Registry: the worker exports each accepted task's
 * verified images into it, and the API serves them to sandbox providers.
 */
export interface TaskImageConfig {
  /** `<region>-docker.pkg.dev/<project>/<repository>` */
  readonly repository: string;
}

export function taskImageConfig(
  value: z.infer<typeof taskImageEnvironmentSchema>,
): TaskImageConfig | undefined {
  const repository = value.SELFBENCH_TASK_IMAGE_REPOSITORY;
  if (!repository) return undefined;
  if (!/^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(repository))
    fail("SELFBENCH_TASK_IMAGE_REPOSITORY must be <region>-docker.pkg.dev/<project>/<repository>");
  return { repository };
}
