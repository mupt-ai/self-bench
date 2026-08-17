import type { Command, Session } from "@vercel/sandbox";
import { InactivityTimeoutError, type RollingOutput } from "./process.js";
import type { SandboxRequest, SandboxResult, SandboxRunOptions } from "./sandbox.js";
import { VercelCommandStartError } from "./vercel-fetch.js";

export const VERCEL_WORK_DIRECTORY = "/work";

const COMPLETION_REQUEST_TIMEOUT_MS = 15_000;

export async function executeVercelCommand(input: {
  readonly session: Session;
  readonly request: SandboxRequest;
  readonly options: SandboxRunOptions;
  readonly signal: AbortSignal;
  readonly terminate: (error: unknown) => void;
  readonly stdout: RollingOutput;
  readonly stderr: RollingOutput;
}): Promise<Omit<SandboxResult, "sandboxId">> {
  const { session, request, options, signal, terminate, stdout, stderr } = input;
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
          `Vercel sandbox ${session.sessionId} stage ${request.stage}`,
          request.inactivityTimeoutMs ?? 0,
        ),
      );
    }, request.inactivityTimeoutMs);
    inactivityTimer.unref();
  };

  try {
    const [commandName, ...commandArguments] = request.command;
    if (!commandName) {
      throw new Error("sandbox command must not be empty");
    }
    const command = await startCommand(session, commandName, commandArguments, request, signal);

    armInactivityTimer();
    await consumeLogs(command, stdout, stderr, options, armInactivityTimer, signal);
    // The log stream closes when remote execution ends. From here on, the
    // bounded completion request is provider settlement rather than command
    // output inactivity.
    clearInactivityTimer();
    const completed = await command.wait({
      signal: AbortSignal.any([signal, AbortSignal.timeout(COMPLETION_REQUEST_TIMEOUT_MS)]),
    });

    const outputs: Record<string, Uint8Array> = {};
    for (const path of request.outputPaths ?? []) {
      const output = await session.readFileToBuffer({ path }, { signal });
      if (output === null) {
        if (completed.exitCode === 0) {
          throw new Error(
            `sandbox ${session.sessionId} exited successfully without output ${path}`,
          );
        }
      } else {
        outputs[path] = output;
      }
    }
    return {
      exitCode: completed.exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      outputs,
    };
  } finally {
    clearInactivityTimer();
  }
}

async function startCommand(
  session: Session,
  commandName: string,
  commandArguments: readonly string[],
  request: SandboxRequest,
  signal: AbortSignal,
): Promise<Command> {
  try {
    return await session.runCommand({
      cmd: commandName,
      args: [...commandArguments],
      cwd: VERCEL_WORK_DIRECTORY,
      detached: true,
      env: { ...request.environment, ...request.secrets },
      signal,
      timeoutMs: request.timeoutMs,
    });
  } catch (error) {
    if (error instanceof VercelCommandStartError) {
      error.restorePublicName();
    }
    throw error;
  }
}

async function consumeLogs(
  command: Command,
  stdout: RollingOutput,
  stderr: RollingOutput,
  options: SandboxRunOptions,
  onOutput: () => void,
  signal: AbortSignal,
): Promise<void> {
  for await (const event of command.logs({ signal })) {
    const chunk = Buffer.from(event.data);
    if (chunk.byteLength === 0) {
      continue;
    }
    const output = event.stream === "stdout" ? stdout : stderr;
    output.push(chunk);
    options.onProgress?.({ stream: event.stream, bytes: chunk.byteLength });
    onOutput();
  }
}
