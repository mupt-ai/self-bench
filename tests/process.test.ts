import { describe, expect, test } from "bun:test";
import { InactivityTimeoutError, runCommand } from "../src/process.js";

describe("runCommand", () => {
  test("terminates a child when its abort signal fires", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 25);
    await runCommand("bash", ["-lc", "trap 'exit 0' TERM; while true; do sleep 0.05; done"], {
      allowFailure: true,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("terminates a child after real output stops", async () => {
    const chunks: number[] = [];
    const startedAt = Date.now();
    const command = runCommand(
      process.execPath,
      ["-e", 'process.stdout.write("started"); setInterval(() => undefined, 1_000)'],
      {
        inactivityTimeoutMs: 50,
        onOutput: (_stream, chunk) => chunks.push(chunk.byteLength),
      },
    );

    await expect(command).rejects.toBeInstanceOf(InactivityTimeoutError);
    expect(chunks.reduce((total, size) => total + size, 0)).toBe(7);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
