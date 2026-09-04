const DEFAULT_ATTEMPTS = 5;
const BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000] as const;

export interface OutputReadOptions {
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

/**
 * Reads a declared sandbox output, retrying transient provider failures with backoff. The sandbox
 * is still alive when outputs are collected, so a 500 from a file API must not turn a delivered
 * submission into a missing one. Resolves undefined only when every attempt failed.
 */
export async function readOutputWithRetry(
  read: () => Promise<Uint8Array | undefined>,
  options: OutputReadOptions = {},
): Promise<{ value: Uint8Array | undefined; attempts: number; lastError?: unknown }> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      const value = await read();
      if (value !== undefined) {
        return { value, attempts: attempt };
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 1_000);
    }
  }
  return { value: undefined, attempts, ...(lastError !== undefined ? { lastError } : {}) };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
