import { spawn } from "node:child_process";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type CommandOutputHandler = (stream: "stdout" | "stderr", chunk: Uint8Array) => void;

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: Uint8Array | string;
  readonly timeoutMs?: number;
  readonly inactivityTimeoutMs?: number;
  readonly allowFailure?: boolean;
  readonly signal?: AbortSignal;
  readonly onOutput?: CommandOutputHandler;
}

export class InactivityTimeoutError extends Error {
  constructor(
    readonly scope: string,
    readonly timeoutMs: number,
  ) {
    super(`${scope} produced no output for ${timeoutMs}ms`);
    this.name = "InactivityTimeoutError";
  }
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = new RollingOutput();
    const stderr = new RollingOutput();
    if (!child.stdout || !child.stderr) {
      reject(new Error(`failed to capture ${command} output`));
      return;
    }
    let inactivityTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let inactivityError: InactivityTimeoutError | undefined;
    const clearInactivityTimer = (): void => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = undefined;
      }
    };
    const terminate = (): void => {
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKillTimer.unref();
    };
    const armInactivityTimer = (): void => {
      clearInactivityTimer();
      if (!options.inactivityTimeoutMs) {
        return;
      }
      inactivityTimer = setTimeout(() => {
        inactivityError = new InactivityTimeoutError(
          `${command} ${args.join(" ")}`,
          options.inactivityTimeoutMs ?? 0,
        );
        terminate();
      }, options.inactivityTimeoutMs);
      inactivityTimer.unref();
    };
    const capture = (stream: "stdout" | "stderr", output: RollingOutput, chunk: Buffer): void => {
      output.push(chunk);
      options.onOutput?.(stream, chunk);
      armInactivityTimer();
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", stderr, chunk));
    child.on("error", reject);

    const abort = () => terminate();
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener("abort", abort, { once: true });
    }

    const timeout = options.timeoutMs
      ? setTimeout(() => terminate(), options.timeoutMs)
      : undefined;
    timeout?.unref();
    armInactivityTimer();

    child.on("close", (exitCode, signal) => {
      options.signal?.removeEventListener("abort", abort);
      clearInactivityTimer();
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      const result = {
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode: exitCode ?? (signal ? 128 : 1),
      };
      if (inactivityError) {
        reject(inactivityError);
        return;
      }
      if (result.exitCode !== 0 && !options.allowFailure) {
        const detail = result.stderr.trim() || result.stdout.trim();
        reject(new Error(`${command} exited ${result.exitCode}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(result);
    });

    if (child.stdin && options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

export class RollingOutput {
  readonly #limit = 8 * 1024 * 1024;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  #truncated = false;

  push(chunk: Buffer): void {
    if (chunk.byteLength >= this.#limit) {
      this.#chunks.length = 0;
      this.#chunks.push(chunk.subarray(chunk.byteLength - this.#limit));
      this.#size = this.#limit;
      this.#truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.byteLength;
    while (this.#size > this.#limit) {
      const first = this.#chunks.shift();
      if (!first) {
        break;
      }
      const overflow = this.#size - this.#limit;
      if (first.byteLength > overflow) {
        this.#chunks.unshift(first.subarray(overflow));
        this.#size -= overflow;
      } else {
        this.#size -= first.byteLength;
      }
      this.#truncated = true;
    }
  }

  text(): string {
    const value = Buffer.concat(this.#chunks, this.#size).toString("utf8");
    return this.#truncated ? `[selfbench: earlier output truncated]\n${value}` : value;
  }
}
