// Each `harbor run` is a Python process that peaks near 200 MiB of anonymous memory regardless of
// the sandbox provider (measured in the production image: 40 concurrent Modal nop gates used
// 7.6 GiB on an 8 GiB host). Activity slots may exceed this limit; gates and solver trials queue.
export const HARBOR_PROCESS_LIMIT = 16;
let active = 0;
const waiting = new Set<() => void>();

export async function withHarborProcess<T>(
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (active < HARBOR_PROCESS_LIMIT) {
    active += 1;
  } else {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        waiting.delete(ready);
        reject(signal?.reason);
      };
      waiting.add(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  try {
    signal?.throwIfAborted();
    return await action();
  } finally {
    const next = waiting.values().next().value;
    if (next) {
      waiting.delete(next);
      next();
    } else {
      active -= 1;
    }
  }
}

export function activeHarborProcesses(): number {
  return active;
}
