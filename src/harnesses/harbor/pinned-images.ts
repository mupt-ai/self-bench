import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type TaskImages, taskImagesSchema } from "../../contracts/index.js";

/** The environment kwargs that start a Modal trial from a task's pinned images. */
export function pinnedImageKwargs(images: TaskImages | undefined): Record<string, string> {
  if (!images) return {};
  return {
    agent_image: images.agent,
    ...(images.verifier ? { verifier_image: images.verifier } : {}),
  };
}

/**
 * The Modal images a Harbor run's sandboxes started from, as runtime/selfbench_modal.py writes
 * them under its `image_record_dir`; undefined when the run recorded no agent image.
 */
export async function recordedImages(directory: string): Promise<TaskImages | undefined> {
  const read = (role: string) =>
    readFile(join(directory, role), "utf8").then(
      (id) => id.trim(),
      () => undefined,
    );
  const [agent, verifier] = await Promise.all([read("agent"), read("verifier")]);
  const parsed = taskImagesSchema.safeParse({
    provider: "modal",
    agent,
    ...(verifier ? { verifier } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}
