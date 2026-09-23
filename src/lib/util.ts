/** Small helpers shared across the codebase. Add here instead of redefining them per module. */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
