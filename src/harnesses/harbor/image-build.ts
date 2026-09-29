import { runCommand } from "../../lib/process.js";
import { tail } from "../../lib/util.js";

const FAILED_IMAGE = /Image build for (im-[A-Za-z0-9]+) failed/;
// Modal's builder ran one of the Dockerfile's own commands and it exited non-zero.
const BUILDER_COMMAND_FAILED = /Terminating task due to error: failed to run builder command/;
// Modal could not pull the FROM image, and the registry said it does not serve that reference.
const BASE_IMAGE_PULL_FAILED = /Terminating task due to error: command skopeo copy /;
const BASE_IMAGE_MISSING =
  /manifest unknown|name unknown|repository does not exist|requested access to the resource is denied|invalid reference format/i;

/**
 * The Modal build log of an image Harbor reported as failed, when the failure came from the task's
 * own Dockerfile steps (a missing tool, a failing setup.sh) or from a base image its registry does
 * not serve, rather than from Modal. Such a failure repeats on every retry, so the author gets the
 * log instead. Undefined for anything else (a registry timeout or rate limit included), which
 * stays a retried infrastructure failure.
 */
export async function authoredImageBuildFailure(
  infrastructure: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string | undefined> {
  const image = FAILED_IMAGE.exec(infrastructure)?.[1];
  if (!image) return undefined;
  const logs = await runCommand("modal", ["image", "logs", image], {
    env,
    allowFailure: true,
    timeoutMs: 60_000,
    signal,
  }).catch(() => undefined);
  if (logs?.exitCode !== 0) return undefined;
  const authored =
    BUILDER_COMMAND_FAILED.test(logs.stdout) ||
    (BASE_IMAGE_PULL_FAILED.test(logs.stdout) && BASE_IMAGE_MISSING.test(logs.stdout));
  if (!authored) return undefined;
  return `--- Modal image build log (${image}) ---\n${tail(logs.stdout.trim(), 12_000)}`;
}
