import { describe, expect, test } from "bun:test";
import { readOutputWithRetry } from "../../src/sandbox/output-retry.js";

describe("readOutputWithRetry", () => {
  test("retries failed reads with backoff and returns the value once a read succeeds", async () => {
    const delays: number[] = [];
    let attempt = 0;
    const result = await readOutputWithRetry(
      async () => {
        attempt += 1;
        if (attempt < 3) {
          throw new Error(`E2B file API 500 (attempt ${attempt})`);
        }
        return Buffer.from("verdict");
      },
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(Buffer.from(result.value ?? []).toString()).toBe("verdict");
    expect(result.attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  test("gives up after five attempts and reports the last error", async () => {
    let attempts = 0;
    const result = await readOutputWithRetry(
      async () => {
        attempts += 1;
        throw new Error("still failing");
      },
      { sleep: async () => undefined },
    );
    expect(attempts).toBe(5);
    expect(result.value).toBeUndefined();
    expect((result.lastError as Error).message).toBe("still failing");
  });

  test("treats an undefined read as missing but retries it too", async () => {
    let attempts = 0;
    const result = await readOutputWithRetry(
      async () => {
        attempts += 1;
        return attempts === 2 ? Buffer.from("late") : undefined;
      },
      { sleep: async () => undefined },
    );
    expect(attempts).toBe(2);
    expect(Buffer.from(result.value ?? []).toString()).toBe("late");
  });
});
