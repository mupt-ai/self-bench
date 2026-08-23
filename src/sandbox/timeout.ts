import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "./contracts.js";

export const STANDARD_VERCEL_TIMEOUT_CAP_MS = 2 * 60 * 60 * 1_000;
export const HOBBY_VERCEL_TIMEOUT_CAP_MS = 45 * 60 * 1_000;

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

  close(): void {
    this.#delegate.close();
  }
}
