import { createWriteStream } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { runCommand } from "../../lib/process.js";
import { tail } from "../../lib/util.js";
import type { BuildFromTask } from "./builder.js";
import { buildSeconds, IMAGE_CONTEXTS, SNAPSHOT_IN_CONTEXT } from "./contexts.js";
import { candidateImageNames } from "./registry.js";

/**
 * Builds a task's two images with the worker's own Docker and pushes them to `repository`, for a
 * local stack (a registry beside it, such as `registry:2` on localhost). The daemon's layer cache
 * keeps a candidate's later checks fast. A Dockerfile step that fails is the author's to fix.
 */
export function dockerBuild(
  repository: string,
  command: typeof runCommand = runCommand,
): BuildFromTask {
  return async (task, store, build, signal) => {
    const snapshot = join(task.root, SNAPSHOT_IN_CONTEXT);
    await pipeline(await store.openRead(build.snapshot), createWriteStream(snapshot), { signal });
    const seconds = await buildSeconds(task.directory);
    const names = candidateImageNames(build.runId, build.candidateId);
    const tag = `attempt-${Date.now().toString(36)}`;
    const images: Record<string, string> = {};
    for (const { role, context } of IMAGE_CONTEXTS) {
      const directory = join(task.directory, context);
      await copyFile(snapshot, join(directory, SNAPSHOT_IN_CONTEXT));
      const image = `${repository}/${names[role]}:${tag}`;
      const built = await command(
        "docker",
        ["build", "--platform", "linux/amd64", "--progress", "plain", "-t", image, directory],
        { allowFailure: true, timeoutMs: seconds * 1000, signal },
      );
      const output = tail(`${built.stdout}\n${built.stderr}`.trim(), 12_000);
      if (built.exitCode === 124)
        return {
          failure: `The ${role} image build exceeded its ${seconds}-second limit.\n\n${output}`,
        };
      if (built.exitCode !== 0) {
        if (/did not complete successfully|returned a non-zero code|manifest unknown/i.test(output))
          return { failure: `--- ${role} image build ---\n${output}` };
        throw new Error(`docker build of the ${role} image failed:\n${output}`);
      }
      const pushed = await command("docker", ["push", image], { signal });
      const digest = /digest: (sha256:[0-9a-f]{64})/.exec(pushed.stdout)?.[1];
      if (!digest) throw new Error(`docker push printed no digest for the ${role} image`);
      images[role] = `${repository}/${names[role]}@${digest}`;
    }
    const { agent, verifier } = images;
    if (!agent || !verifier) throw new Error("the Docker build produced no images");
    return { images: { agent, verifier } };
  };
}
