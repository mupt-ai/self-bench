import { setTimeout as delay } from "node:timers/promises";
import { APIError, Sandbox } from "@vercel/sandbox";
import type { VercelExecutionConfig } from "./validation.js";

export const VERCEL_CLEANUP_TIMEOUT_MS = 60_000;
const CLEANUP_RETRY_DELAY_MS = 1_000;
const CREATE_RATE_LIMIT_RETRIES = 2;
const CREATE_RATE_LIMIT_FALLBACK_DELAY_MS = 30_000;
const CREATE_RATE_LIMIT_MAX_DELAY_MS = 60_000;
const CREATE_REQUEST_TIMEOUT_MS = 60_000;
const LATE_CREATE_RECOVERY_DELAYS_MS = [0, 250, 750, 1_500] as const;

export type Sleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

export class VercelSandboxLifecycle {
  readonly #config: VercelExecutionConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: Sleep;

  constructor(config: VercelExecutionConfig, fetch: typeof globalThis.fetch, sleep: Sleep) {
    this.#config = config;
    this.#fetch = fetch;
    this.#sleep = sleep;
  }
  async createSandbox(
    name: string,
    tags: Readonly<Record<string, string>>,
    vcpus: number,
    timeoutMs: number,
    signal: AbortSignal,
    setAllocationMayExist: (value: boolean) => void,
  ): Promise<Sandbox> {
    for (let retries = 0; ; retries += 1) {
      signal.throwIfAborted();
      setAllocationMayExist(true);
      try {
        return await Sandbox.create({
          ...this.#config.credentials,
          fetch: this.#fetch,
          image: this.#config.image,
          name,
          persistent: false,
          resources: { vcpus },
          signal: withTimeout(signal, CREATE_REQUEST_TIMEOUT_MS),
          tags: { ...tags },
          timeout: timeoutMs,
        });
      } catch (error) {
        if (createErrorConfirmsNoAllocation(error)) {
          setAllocationMayExist(false);
        }
        if (
          !(error instanceof APIError) ||
          error.response.status !== 429 ||
          retries >= CREATE_RATE_LIMIT_RETRIES
        ) {
          throw error;
        }
        await this.#sleep(createRetryDelayMs(error.response), signal);
      }
    }
  }

  async cleanup(
    name: string,
    sandbox: Sandbox | undefined,
    deleteHandle: () => Promise<void>,
    allocationMayExist: boolean,
  ): Promise<void> {
    let directDeleteError: unknown;
    if (sandbox) {
      try {
        await deleteHandle();
        return;
      } catch (error) {
        directDeleteError = error;
      }
    }
    if (!sandbox && !allocationMayExist) {
      return;
    }

    try {
      const recoveryDelays = sandbox ? [CLEANUP_RETRY_DELAY_MS] : LATE_CREATE_RECOVERY_DELAYS_MS;
      for (const delayMs of recoveryDelays) {
        if (delayMs > 0) {
          await this.#sleep(delayMs, AbortSignal.timeout(VERCEL_CLEANUP_TIMEOUT_MS));
        }
        let handle: Sandbox;
        try {
          handle = await Sandbox.get({
            ...this.#config.credentials,
            fetch: this.#fetch,
            name,
            resume: false,
            signal: AbortSignal.timeout(VERCEL_CLEANUP_TIMEOUT_MS),
          });
        } catch (error) {
          if (error instanceof APIError && error.response.status === 404) {
            if (sandbox) {
              return;
            }
            continue;
          }
          throw error;
        }
        try {
          await handle.delete({ signal: AbortSignal.timeout(VERCEL_CLEANUP_TIMEOUT_MS) });
        } catch (error) {
          if (error instanceof APIError && error.response.status === 404) {
            return;
          }
          throw error;
        }
        return;
      }
      throw new Error("sandbox absence remained unconfirmed after an ambiguous create failure");
    } catch (recoveryError) {
      const errors =
        directDeleteError === undefined ? [recoveryError] : [directDeleteError, recoveryError];
      throw new AggregateError(
        errors,
        `failed to delete Vercel sandbox ${name}: ${errors.map(errorMessage).join("; ")}`,
      );
    }
  }
}

export function sandboxName(runId: string, stage: string): string {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const context = `${runId}-${stage}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const prefix = `selfbench-${context}`.slice(0, 128 - suffix.length - 1).replace(/-+$/g, "");
  return `${prefix}-${suffix}`;
}

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

export async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await delay(delayMs, undefined, { signal });
}

function createRetryDelayMs(response: Response): number {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return CREATE_RATE_LIMIT_FALLBACK_DELAY_MS;
  const seconds = Number(header);
  const requestedDelay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(header) - Date.now();
  return Number.isFinite(requestedDelay)
    ? Math.min(CREATE_RATE_LIMIT_MAX_DELAY_MS, Math.max(0, Math.ceil(requestedDelay)))
    : CREATE_RATE_LIMIT_FALLBACK_DELAY_MS;
}

function createErrorConfirmsNoAllocation(error: unknown): boolean {
  if (!(error instanceof APIError)) return false;
  const status = error.response.status;
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 499;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
