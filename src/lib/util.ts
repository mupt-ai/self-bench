/** Small helpers shared across the codebase. Add here instead of redefining them per module. */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The token in an `Authorization: Bearer <token>` header; undefined for any other scheme or shape. */
export function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer +(\S+)$/i.exec(header?.trim() ?? "")?.[1];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Single-quotes a value for POSIX shells. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function fail(message: string): never {
  throw new Error(message);
}

/** Resolves after `ms`; the timer never keeps the process alive. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** The last `maxBytes` of a string, marked when something was cut. */
export function tail(value: string, maxBytes = 8_000): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return `[truncated ${bytes.length - maxBytes} bytes]\n${bytes.subarray(bytes.length - maxBytes).toString("utf8")}`;
}

/**
 * Settles with `operation`, or rejects with the abort reason as soon as `signal` aborts (also
 * when it already has). A late rejection of the abandoned operation is swallowed, never left
 * unhandled.
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  operation.catch(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
