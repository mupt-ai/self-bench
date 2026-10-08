import { SandboxCapacityError } from "./contracts.js";
import type { CredentialCapacity } from "./credential-capacity.js";

/** Harbor holds a slot through build, execution, and teardown; waiting remains cancellable. */
export async function withCredentialCapacity<T>(
  capacity: CredentialCapacity,
  timeoutMs: number,
  signal: AbortSignal,
  heartbeat: () => void,
  run: () => Promise<T>,
): Promise<T> {
  let lease: string;
  for (;;) {
    signal.throwIfAborted();
    try {
      lease = await capacity.acquire(timeoutMs);
      break;
    } catch (error) {
      if (!(error instanceof SandboxCapacityError)) throw error;
      heartbeat();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 10_000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  try {
    return await run();
  } finally {
    await capacity.release(lease);
  }
}
