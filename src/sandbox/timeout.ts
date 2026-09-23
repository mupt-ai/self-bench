import { z } from "zod";
import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
  StartedSandbox,
} from "./contracts.js";

function parseSandboxTimeoutCapText(value: string): number | undefined {
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

/**
 * A provider's configured sandbox lifetime cap, like `45m` or `2h`: validated against the
 * provider's own ceiling, which is also the default.
 */
export function providerTimeoutCap(value: string | undefined, maximumMs: number): number {
  if (value === undefined) {
    return maximumMs;
  }
  return z.number().int().min(100).max(maximumMs).parse(parseSandboxTimeoutCapText(value));
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
    return await this.#delegate.run(this.#capped(request), options);
  }

  start(
    request: SandboxRequest,
    secretsFor?: (sandbox: StartedSandbox) => Readonly<Record<string, string>>,
  ) {
    return this.#delegate.start(this.#capped(request), secretsFor);
  }

  stop(sandbox: StartedSandbox): Promise<void> {
    return this.#delegate.stop(sandbox);
  }

  #capped(request: SandboxRequest): SandboxRequest {
    return request.timeoutMs > this.#timeoutCapMs
      ? { ...request, timeoutMs: this.#timeoutCapMs }
      : request;
  }

  close(): void {
    this.#delegate.close();
  }
}
