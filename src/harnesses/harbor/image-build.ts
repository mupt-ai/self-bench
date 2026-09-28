import { runCommand } from "../../lib/process.js";
import { tail } from "../../lib/util.js";

const FAILED_IMAGE = /Image build for (im-[A-Za-z0-9]+) failed/;
// Modal's builder ran one of the Dockerfile's own commands and it exited non-zero.
const BUILDER_COMMAND_FAILED = /Terminating task due to error: failed to run builder command/;

/**
 * The Modal build log of an image Harbor reported as failed, when the failure came from the task's
 * own Dockerfile steps (a missing tool, a failing setup.sh) rather than from Modal. Such a failure
 * repeats on every retry, so the author gets the log instead. Undefined for anything else, which
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
  if (logs?.exitCode !== 0 || !BUILDER_COMMAND_FAILED.test(logs.stdout)) return undefined;
  return `--- Modal image build log (${image}) ---\n${tail(logs.stdout.trim(), 12_000)}`;
}
