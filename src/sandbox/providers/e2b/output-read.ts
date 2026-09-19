import type { E2BSandboxHandle } from "./types.js";

// The SDK shares its file transport across sandboxes. Concurrent ~100 MB archive reads can
// repeatedly hit the request deadline and restart from zero. Keep control-file reads independent.
const ARCHIVE_READ_LIMIT = 2;
let active = 0;
const waiting = new Set<() => void>();

export async function readE2BOutput(
  sandbox: E2BSandboxHandle,
  path: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (!path.endsWith(".tar.gz")) return sandbox.files.read(path, { format: "bytes", signal });
  if (active < ARCHIVE_READ_LIMIT) {
    active += 1;
  } else {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        waiting.delete(ready);
        reject(signal.reason);
      };
      waiting.add(ready);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  try {
    signal.throwIfAborted();
    return await sandbox.files.read(path, { format: "bytes", signal });
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
