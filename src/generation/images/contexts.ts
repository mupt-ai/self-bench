import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { runCommand } from "../../lib/process.js";
import { isRecord } from "../../lib/util.js";
import { parseImageReference } from "../task/image-registry.js";

/** The two images of a task and the build context each is built from. */
export const IMAGE_CONTEXTS = [
  { role: "agent", context: "environment" },
  { role: "verifier", context: "tests" },
] as const;

/** Both contexts' Dockerfiles copy this, the repository snapshot the gate task leaves out. */
export const SNAPSHOT_IN_CONTEXT = "repo.tar.gz";

/** Harbor's own default when a task sets no build timeout (harbor/models/task/config.py). */
const DEFAULT_BUILD_SECONDS = 600;

/** The longest either image's build may take, by the task's own limits. */
export async function buildSeconds(taskDirectory: string): Promise<number> {
  const config = parse(await readFile(join(taskDirectory, "task.toml"), "utf8"));
  const seconds = (section: unknown) => {
    const value = isRecord(section) ? section.build_timeout_sec : undefined;
    return typeof value === "number" && value > 0 ? value : DEFAULT_BUILD_SECONDS;
  };
  const verifier = isRecord(config.verifier) ? config.verifier.environment : undefined;
  return Math.ceil(Math.max(seconds(config.environment), seconds(verifier)));
}

/**
 * Points every digest-pinned Docker Hub `FROM` at the same digest in `mirror` (an Artifact Registry
 * remote repository of Docker Hub), so builds never pull Docker Hub anonymously from shared
 * addresses that hit its rate limit. The content is the same by digest.
 */
export function mirrorDockerHub(dockerfile: string, mirror: string): string {
  return dockerfile
    .split("\n")
    .map((line) => {
      const from = /^(\s*FROM\s+(?:--\S+\s+)*)(\S+)(.*)$/i.exec(line);
      const parsed = from?.[2] ? parseImageReference(from[2]) : undefined;
      if (!from || !parsed?.digest || parsed.host !== "registry-1.docker.io") return line;
      const tag = parsed.tag ? `:${parsed.tag}` : "";
      return `${from[1]}${mirror}/${parsed.repository}${tag}@${parsed.digest}${from[3]}`;
    })
    .join("\n");
}

/** Mirrors both contexts' Dockerfiles in place, when the deployment has a mirror. */
export async function mirrorContexts(taskDirectory: string, mirror: string | undefined) {
  if (!mirror) return;
  for (const { context } of IMAGE_CONTEXTS) {
    const path = join(taskDirectory, context, "Dockerfile");
    await writeFile(path, mirrorDockerHub(await readFile(path, "utf8"), mirror));
  }
}

/** Packs both contexts (without the snapshot, which the build fetches) into `archive`. */
export async function packContexts(taskDirectory: string, archive: string, signal: AbortSignal) {
  await runCommand(
    "tar",
    ["-czf", archive, "-C", taskDirectory, ...IMAGE_CONTEXTS.map(({ context }) => context)],
    { signal },
  );
}
