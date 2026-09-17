import { setTimeout as delay } from "node:timers/promises";
export function createTerminationGate(): {
  readonly promise: Promise<never>;
  readonly reject: (error: unknown) => void;
} {
  let reject = (_error: unknown): void => {};
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, reject };
}

export async function raceWithTermination<T>(
  operation: Promise<T>,
  termination: Promise<never>,
): Promise<T> {
  void operation.catch(() => undefined);
  return await Promise.race([operation, termination]);
}

export async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw abortReason(signal);
  }
  let removeAbortListener = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      void operation.catch(() => undefined);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener();
  }
}

export function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export async function waitForCommandKill(
  commandKill: Promise<boolean> | undefined,
  diagnosticSignal: AbortSignal,
  graceMs: number,
): Promise<void> {
  if (!commandKill) return;
  const signal = AbortSignal.any([diagnosticSignal, AbortSignal.timeout(graceMs)]);
  try {
    await raceWithSignal(commandKill, signal);
  } catch {
    // Sandbox cleanup remains the authoritative process/resource stop.
  }
}

export async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await delay(delayMs, undefined, { signal });
}
