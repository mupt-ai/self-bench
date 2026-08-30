import { type Sandbox, type SandboxInfo, SandboxNotFoundError } from "e2b";
import type { E2BLifecycleTimings, E2BSleep } from "./config.js";
import { raceWithSignal } from "./lifecycle.js";
import type { E2BSandboxApi, E2BSandboxHandle } from "./types.js";

export class E2BCleanup {
  readonly #api: E2BSandboxApi;
  readonly #sleep: E2BSleep;
  readonly #timings: E2BLifecycleTimings;

  constructor(api: E2BSandboxApi, sleep: E2BSleep, timings: E2BLifecycleTimings) {
    this.#api = api;
    this.#sleep = sleep;
    this.#timings = timings;
  }
  async cleanup(
    metadata: Readonly<Record<string, string>>,
    getSandbox: () => E2BSandboxHandle | undefined,
    allocationMayExist: () => boolean,
  ): Promise<void> {
    const signal = AbortSignal.timeout(this.#timings.cleanupTimeoutMs);
    const sandbox = getSandbox();
    if (sandbox) {
      await this.#cleanupKnownSandbox(sandbox, signal);
      return;
    }
    if (!allocationMayExist()) {
      return;
    }

    let recoveryError: unknown;
    for (const delayMs of this.#timings.cleanupRecoveryDelaysMs) {
      try {
        if (delayMs > 0) {
          signal.throwIfAborted();
          await raceWithSignal(this.#sleep(delayMs, signal), signal);
        }
        const lateSandbox = getSandbox();
        if (lateSandbox) {
          await this.#cleanupKnownSandbox(lateSandbox, signal);
          return;
        }
        if (!allocationMayExist()) {
          return;
        }
        const matches = await this.#findSandboxes(metadata, signal);
        if (matches.length === 0) {
          continue;
        }
        for (const match of matches) {
          await this.#killAndConfirmAbsent(match.sandboxId, signal);
        }
        return;
      } catch (error) {
        recoveryError = error;
      }
    }
    const detail = recoveryError
      ? errorMessage(recoveryError)
      : "sandbox absence remained unconfirmed after an ambiguous create failure";
    throw new Error(`failed to recover an E2B sandbox after ambiguous creation: ${detail}`, {
      cause: recoveryError,
    });
  }

  async #cleanupKnownSandbox(sandbox: E2BSandboxHandle, signal: AbortSignal): Promise<void> {
    let directKillError: unknown;
    try {
      await this.#cleanupCall(
        (callSignal) =>
          sandbox.kill(cleanupOptions(callSignal, this.#timings.cleanupCallTimeoutMs)),
        signal,
      );
      if (await this.#sandboxIsAbsent(sandbox.sandboxId, signal)) {
        return;
      }
    } catch (error) {
      directKillError = error;
    }

    try {
      await this.#killAndConfirmAbsent(sandbox.sandboxId, signal);
    } catch (fallbackError) {
      const errors =
        directKillError === undefined ? [fallbackError] : [directKillError, fallbackError];
      throw new AggregateError(
        errors,
        `failed to confirm E2B sandbox ${sandbox.sandboxId} cleanup: ${errors.map(errorMessage).join("; ")}`,
      );
    }
  }

  async #killAndConfirmAbsent(sandboxId: string, signal: AbortSignal): Promise<void> {
    for (const delayMs of this.#timings.cleanupRecoveryDelaysMs) {
      if (delayMs > 0) {
        signal.throwIfAborted();
        await raceWithSignal(this.#sleep(delayMs, signal), signal);
      }
      await this.#cleanupCall(
        (callSignal) =>
          this.#api.kill(sandboxId, cleanupOptions(callSignal, this.#timings.cleanupCallTimeoutMs)),
        signal,
      );
      if (await this.#sandboxIsAbsent(sandboxId, signal)) {
        return;
      }
    }
    throw new Error(`E2B sandbox ${sandboxId} still exists after repeated kill requests`);
  }

  async #sandboxIsAbsent(sandboxId: string, signal: AbortSignal): Promise<boolean> {
    try {
      await this.#cleanupCall(
        (callSignal) =>
          this.#api.getInfo(
            sandboxId,
            cleanupOptions(callSignal, this.#timings.cleanupCallTimeoutMs),
          ),
        signal,
      );
      return false;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        return true;
      }
      throw error;
    }
  }

  async #findSandboxes(
    metadata: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<SandboxInfo[]> {
    const paginator = this.#api.list({ limit: 100, query: { metadata: { ...metadata } } });
    const matches: SandboxInfo[] = [];
    while (paginator.hasNext) {
      matches.push(
        ...(await this.#cleanupCall(
          (callSignal) =>
            paginator.nextItems(cleanupOptions(callSignal, this.#timings.cleanupCallTimeoutMs)),
          signal,
        )),
      );
    }
    return matches;
  }

  async #cleanupCall<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    cleanupSignal: AbortSignal,
  ): Promise<T> {
    const callSignal = AbortSignal.any([
      cleanupSignal,
      AbortSignal.timeout(this.#timings.cleanupCallTimeoutMs),
    ]);
    callSignal.throwIfAborted();
    return await raceWithSignal(operation(callSignal), callSignal);
  }
}

function cleanupOptions(
  signal: AbortSignal,
  requestTimeoutMs: number,
): Parameters<typeof Sandbox.kill>[1] {
  return { requestTimeoutMs, signal };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
