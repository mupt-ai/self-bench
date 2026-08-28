import type { CommandHandle, CommandResult } from "e2b";
import { InactivityTimeoutError, type RollingOutput } from "../../../process.js";
import type { SandboxRequest, SandboxResult, SandboxRunOptions } from "../../contracts.js";
import { raceWithTermination } from "./lifecycle.js";
import type { E2BSandboxHandle } from "./types.js";

export const E2B_WORK_DIRECTORY = "/work";

export async function executeE2BCommand(input: {
  readonly sandbox: E2BSandboxHandle;
  readonly request: SandboxRequest;
  readonly options: SandboxRunOptions;
  readonly signal: AbortSignal;
  readonly terminate: (error: unknown) => void;
  readonly stdout: RollingOutput;
  readonly stderr: RollingOutput;
  readonly termination: Promise<never>;
  readonly setCommand: (command: CommandHandle) => void;
}): Promise<SandboxResult> {
  const { sandbox, request, options, signal, terminate, stdout, stderr, termination, setCommand } =
    input;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const clearInactivityTimer = (): void => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = undefined;
    }
  };
  const armInactivityTimer = (): void => {
    clearInactivityTimer();
    if (!request.inactivityTimeoutMs) {
      return;
    }
    inactivityTimer = setTimeout(() => {
      terminate(
        new InactivityTimeoutError(
          `E2B sandbox ${sandbox.sandboxId} stage ${request.stage}`,
          request.inactivityTimeoutMs ?? 0,
        ),
      );
    }, request.inactivityTimeoutMs);
    inactivityTimer.unref();
  };
  const capture = (stream: "stdout" | "stderr", data: string): void => {
    const chunk = Buffer.from(data);
    if (chunk.byteLength === 0) {
      return;
    }
    (stream === "stdout" ? stdout : stderr).push(chunk);
    options.onProgress?.({ stream, bytes: chunk.byteLength });
    armInactivityTimer();
  };

  try {
    const command = await raceWithTermination(
      sandbox.commands
        .run(shellCommand(request.command), {
          background: true,
          cwd: E2B_WORK_DIRECTORY,
          envs: workloadEnvironment(request),
          onStderr: (data) => capture("stderr", data),
          onStdout: (data) => capture("stdout", data),
          signal,
          timeoutMs: request.timeoutMs,
        })
        .then((handle) => {
          setCommand(handle);
          return handle;
        }),
      termination,
    );
    armInactivityTimer();

    let completed: CommandResult;
    try {
      completed = await raceWithTermination(command.wait(), termination);
    } catch (error) {
      if (!isCommandResult(error)) {
        throw error;
      }
      completed = error;
    }
    clearInactivityTimer();
    captureUnstreamedCommandOutput(completed, stdout, stderr);

    const outputs = await raceWithTermination(
      collectOutputs(sandbox, request, completed.exitCode, signal),
      termination,
    );
    return {
      sandboxId: sandbox.sandboxId,
      exitCode: completed.exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      outputs,
    };
  } finally {
    clearInactivityTimer();
  }
}

function shellCommand(command: readonly string[]): string {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function workloadEnvironment(request: SandboxRequest): Record<string, string> {
  const environment = { ...request.environment, ...request.secrets };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("E2B_")) {
      delete environment[key];
    }
  }
  return environment;
}

async function collectOutputs(
  sandbox: E2BSandboxHandle,
  request: SandboxRequest,
  exitCode: number,
  signal: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  const outputs: Record<string, Uint8Array> = {};
  for (const path of request.outputPaths ?? []) {
    try {
      outputs[path] = await sandbox.files.read(path, { format: "bytes", signal });
    } catch (error) {
      if (exitCode === 0) {
        throw new Error(`sandbox ${sandbox.sandboxId} exited successfully without output ${path}`, {
          cause: error,
        });
      }
    }
  }
  return outputs;
}

function captureUnstreamedCommandOutput(
  completed: CommandResult,
  stdout: RollingOutput,
  stderr: RollingOutput,
): void {
  if (!stdout.text() && completed.stdout) {
    stdout.push(Buffer.from(completed.stdout));
  }
  if (!stderr.text() && completed.stderr) {
    stderr.push(Buffer.from(completed.stderr));
  }
}

function isCommandResult(error: unknown): error is CommandResult {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as Partial<CommandResult>).exitCode === "number" &&
    typeof (error as Partial<CommandResult>).stdout === "string" &&
    typeof (error as Partial<CommandResult>).stderr === "string"
  );
}
