import { harborChildEnvironment } from "../../harbor-environment.js";
import { type CommandResult, runCommand } from "../../process.js";

/** Harbor's default Modal app; image builds for its sandboxes log under it. */
export const HARBOR_MODAL_APP = "__harbor__";
const LOG_TAIL_BYTES = 4_000;
const LOG_ENTRIES = 400;

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<Pick<CommandResult, "exitCode" | "stdout" | "stderr">>;

export function extractModalImageId(message: string): string | undefined {
  return /\bim-[A-Za-z0-9]+\b/.exec(message)?.[0];
}

/**
 * Best-effort Modal build log for an ImageBuildError. `modal image` cannot fetch build logs, so
 * the recent logs of Harbor's Modal app are fetched and filtered around the image id. When that
 * fails the report says so instead of carrying only the bare id.
 */
export async function modalBuildLogTail(
  message: string,
  run: CommandRunner = defaultRunner,
): Promise<string | undefined> {
  const imageId = extractModalImageId(message);
  if (!imageId) {
    return undefined;
  }
  let result: Awaited<ReturnType<CommandRunner>>;
  try {
    result = await run("modal", ["app", "logs", HARBOR_MODAL_APP, "--tail", String(LOG_ENTRIES)]);
  } catch (error) {
    return unavailable(imageId, error instanceof Error ? error.message : String(error));
  }
  if (result.exitCode !== 0) {
    return unavailable(imageId, result.stderr.trim() || `modal exited ${result.exitCode}`);
  }
  const lines = result.stdout.split("\n");
  const around = lines.filter((line) => line.includes(imageId));
  const selected = (
    around.length > 0 ? lines.slice(Math.max(0, lines.indexOf(around[0] ?? "") - 5)) : lines
  )
    .join("\n")
    .trim();
  if (!selected) {
    return unavailable(imageId, `no recent log entries in Modal app ${HARBOR_MODAL_APP}`);
  }
  return `Modal build log for ${imageId} (tail of \`modal app logs ${HARBOR_MODAL_APP}\`):\n${tail(selected)}`;
}

function unavailable(imageId: string, reason: string): string {
  return `Modal build log for ${imageId} could not be fetched (${tail(reason, 300)}); open the image in the Modal dashboard for the full build output.`;
}

function tail(value: string, maxBytes = LOG_TAIL_BYTES): string {
  const buffer = Buffer.from(value);
  return buffer.length <= maxBytes
    ? value
    : `[truncated ${buffer.length - maxBytes} bytes]\n${buffer.subarray(-maxBytes).toString("utf8")}`;
}

async function defaultRunner(
  command: string,
  args: readonly string[],
): Promise<Pick<CommandResult, "exitCode" | "stdout" | "stderr">> {
  return await runCommand(command, args, {
    allowFailure: true,
    env: harborChildEnvironment(),
    timeoutMs: 60_000,
  });
}
