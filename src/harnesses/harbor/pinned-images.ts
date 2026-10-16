import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarborEnvironment } from "../../contracts/config/providers.js";
import { type TaskImages, taskImagesSchema } from "../../contracts/index.js";

/** Providers whose verified images the worker records and, once accepted, exports. */
const RECORDING = new Set<HarborEnvironment>(["modal", "e2b", "daytona", "vercel"]);

function recordsImages(environment: HarborEnvironment): boolean {
  return RECORDING.has(environment);
}

/**
 * The run kwargs that make a provider record the image each role's sandbox started from:
 * `image_record_dir` (runtime/registry_auth.py's record_image), and for Daytona `auto_snapshot`,
 * so its image is a named snapshot a later sandbox can start from.
 */
export function imageRecordKwargs(
  environment: HarborEnvironment,
  directory: string,
): Record<string, string> {
  if (!recordsImages(environment)) return {};
  return {
    image_record_dir: directory,
    ...(environment === "daytona" ? { auto_snapshot: "true" } : {}),
  };
}

/** The environment kwargs that start a Modal trial from a task's pinned images. */
export function pinnedImageKwargs(images: TaskImages | undefined): Record<string, string> {
  if (images?.provider !== "modal") return {};
  return {
    agent_image: images.agent,
    ...(images.verifier ? { verifier_image: images.verifier } : {}),
  };
}

/**
 * The provider images a Harbor run's sandboxes started from, as the SelfBench environments write
 * them under their `image_record_dir`; undefined when the run recorded no agent image.
 */
export async function recordedImages(
  directory: string,
  environment: HarborEnvironment,
): Promise<TaskImages | undefined> {
  if (!recordsImages(environment)) return undefined;
  const read = (role: string) =>
    readFile(join(directory, role), "utf8").then(
      (id) => id.trim(),
      () => undefined,
    );
  const [agent, verifier] = await Promise.all([read("agent"), read("verifier")]);
  const parsed = taskImagesSchema.safeParse({
    provider: environment,
    agent,
    ...(verifier ? { verifier } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}
