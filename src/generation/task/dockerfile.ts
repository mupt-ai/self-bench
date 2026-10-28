import { parseImageReference, type RegistryOptions, resolveImage } from "./image-registry.js";

const FROM = /^(\s*FROM\s+(?:--\S+\s+)*)(\S+)(.*)$/i;

/** The image each `FROM` line names, keyed by line; a `FROM` of an earlier stage names none. */
function baseImages(dockerfile: string): Map<number, string> {
  const stages = new Set(["scratch"]);
  const images = new Map<number, string>();
  for (const [index, line] of dockerfile.split("\n").entries()) {
    const [, , image, rest = ""] = FROM.exec(line) ?? [];
    if (!image) continue;
    if (!stages.has(image.toLowerCase())) images.set(index, image);
    const stage = /^\s+AS\s+(\S+)/i.exec(rest)?.[1];
    if (stage) stages.add(stage.toLowerCase());
  }
  return images;
}

/** Each base image must be written out by tag or digest, so the compiler can pin it. */
export function baseImageProblems(dockerfile: string): string[] {
  const images = [...baseImages(dockerfile).values()];
  if (images.length === 0) return ["Dockerfile has no FROM"];
  return images
    .filter((image) => {
      const reference = parseImageReference(image);
      return !reference?.tag && !reference?.digest;
    })
    .map(
      (image) =>
        `Dockerfile FROM ${image} must name an image literally, by tag (node:22-bookworm) or by a sha256 digest the repository pins`,
    );
}

/**
 * Pins every base image to the digest its registry serves now, so the task builds the same
 * image every time. Problems are the author's; a registry that cannot answer throws.
 */
export async function pinBaseImages(
  dockerfile: string,
  options: RegistryOptions = {},
): Promise<{ dockerfile: string; problems: string[] }> {
  const images = baseImages(dockerfile);
  const unique = [...new Set(images.values())];
  const resolved = new Map(
    await Promise.all(
      unique.map(async (image) => [image, await resolveImage(image, options)] as const),
    ),
  );
  const problems = [...resolved.values()].flatMap((result) => (result.ok ? [] : [result.problem]));
  const pinned = dockerfile
    .split("\n")
    .map((line, index) => {
      const result = resolved.get(images.get(index) ?? "");
      return result?.ok ? line.replace(FROM, `$1${result.image}$3`) : line;
    })
    .join("\n");
  return { dockerfile: pinned, problems };
}
