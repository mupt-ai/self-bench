import { type CommandResult, runCommand } from "../../../process.js";

const CLEANUP_COMMAND_TIMEOUT_MS = 10_000;
type Resource = "container" | "volume";

export class DockerCleanupError extends AggregateError {
  readonly ownershipFailure = true;
  constructor(sandboxId: string, failures: readonly unknown[]) {
    super(failures, `Docker sandbox cleanup could not be confirmed for ${sandboxId}`);
    this.name = "DockerSandboxCleanupError";
  }
}

/** Removal and absence checks are Docker-specific; never infer absence from CLI error text. */
export async function cleanupDockerResources(
  sandboxId: string,
  run: typeof runCommand = runCommand,
  commandTimeoutMs = CLEANUP_COMMAND_TIMEOUT_MS,
): Promise<void> {
  const failures: unknown[] = [];
  for (const resource of ["container", "volume"] as const) {
    try {
      await removeResource(resource, sandboxId, run, commandTimeoutMs);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new DockerCleanupError(sandboxId, failures);
}

async function removeResource(
  resource: Resource,
  name: string,
  run: typeof runCommand,
  timeoutMs: number,
): Promise<void> {
  let removalFailure: unknown;
  try {
    const args =
      resource === "container" ? ["rm", "--force", name] : ["volume", "rm", "--force", name];
    const result = await cleanupCommand(args, run, timeoutMs);
    if (result.exitCode === 0) return;
    removalFailure = commandFailure(`${resource} removal`, result);
  } catch (error) {
    removalFailure = error;
  }

  try {
    const result = await cleanupCommand(
      [
        resource,
        "ls",
        ...(resource === "container" ? ["--all"] : []),
        "--format",
        resource === "container" ? "{{json .Names}}" : "{{json .Name}}",
      ],
      run,
      timeoutMs,
    );
    if (result.exitCode !== 0) throw commandFailure(`${resource} listing`, result);
    // Read the entire listing. RollingOutput's truncation marker and malformed rows
    // fail JSON parsing, so a partial listing can never establish absence.
    const names = result.stdout
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "string" || !value)
          throw new Error(`invalid Docker ${resource} listing`);
        // Docker's container Names column can contain comma-separated names.
        const entries = resource === "container" ? value.split(",") : [value];
        return entries.map((entry) => {
          const normalized = entry.trim().replace(/^\//, "");
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(normalized)) {
            throw new Error(`invalid Docker ${resource} name in listing`);
          }
          return normalized;
        });
      });
    if (names.includes(name)) throw new Error(`Docker ${resource} ${name} still exists`);
  } catch (error) {
    throw new AggregateError(
      [removalFailure, error],
      `Docker ${resource} ${name} cleanup is unconfirmed`,
    );
  }
}

/** Independent cleanup cancellation: a cancelled workload must still be disposed. */
async function cleanupCommand(
  args: readonly string[],
  run: typeof runCommand,
  timeoutMs: number,
): Promise<CommandResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Docker cleanup command exceeded ${timeoutMs}ms: ${args.join(" ")}`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    // The local race also bounds an unresponsive runner. runCommand handles process
    // termination on abort, including its existing SIGKILL grace after SIGTERM.
    return await Promise.race([
      run("docker", args, { allowFailure: true, timeoutMs, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function commandFailure(operation: string, result: CommandResult): Error {
  return new Error(
    `Docker ${operation} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
  );
}
