import type {
  SandboxExecResult,
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "./contracts.js";

export const STANDARD_VERCEL_TIMEOUT_CAP_MS = 2 * 60 * 60 * 1_000;
export const HOBBY_VERCEL_TIMEOUT_CAP_MS = 45 * 60 * 1_000;

// E2B keeps a sandbox alive for at most 24 hours on Pro and 1 hour on Hobby.
export const STANDARD_E2B_TIMEOUT_CAP_MS = 24 * 60 * 60 * 1_000;
export const HOBBY_E2B_TIMEOUT_CAP_MS = 60 * 60 * 1_000;

export function parseSandboxTimeoutCapText(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") {
    return undefined;
  }
  const match = /^(\d+)(ms|s|m|h)?$/.exec(normalized);
  if (!match?.[1]) {
    return Number.NaN;
  }
  const amount = Number(match[1]);
  const multiplier =
    match[2] === "h"
      ? 60 * 60 * 1_000
      : match[2] === "m"
        ? 60 * 1_000
        : match[2] === "s"
          ? 1_000
          : 1;
  return amount * multiplier;
}

export class TimeoutCappedSandboxExecutor implements SandboxExecutor {
  readonly #delegate: SandboxExecutor;
  readonly #timeoutCapMs: number;

  constructor(delegate: SandboxExecutor, timeoutCapMs: number) {
    if (!Number.isInteger(timeoutCapMs) || timeoutCapMs < 100) {
      throw new Error("sandbox timeout cap must be an integer of at least 100ms");
    }
    this.#delegate = delegate;
    this.#timeoutCapMs = timeoutCapMs;
  }

  async run(request: SandboxRequest, options?: SandboxRunOptions): Promise<SandboxResult> {
    return await this.#delegate.run(
      request.timeoutMs > this.#timeoutCapMs
        ? { ...request, timeoutMs: this.#timeoutCapMs }
        : request,
      options,
    );
  }

  execute(sandboxId: string, command: readonly string[]): Promise<SandboxExecResult> {
    return this.#delegate.execute(sandboxId, command);
  }

  readFile(sandboxId: string, path: string): Promise<Uint8Array | undefined> {
    return this.#delegate.readFile(sandboxId, path);
  }

  writeFile(sandboxId: string, path: string, contents: Uint8Array | string): Promise<void> {
    return this.#delegate.writeFile(sandboxId, path, contents);
  }

  close(): void {
    this.#delegate.close();
  }
}
