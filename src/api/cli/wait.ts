/** How often `--wait` asks again, and how long it waits at most (a summary may take 12 minutes). */
const INTERVAL_MS = 5_000;
const TIMEOUT_MS = 20 * 60_000;

/** Asks `check` until it returns a value, then returns it; throws once the wait runs out. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined>,
  interval = INTERVAL_MS,
): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    process.stderr.write(`Waiting for ${what}…\n`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
