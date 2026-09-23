import { describe, expect, test } from "bun:test";
import { CommandTimeoutError, runCommand } from "../src/lib/process.js";

describe("runCommand", () => {
  test("terminates a child when its abort signal fires", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 25);
    await expect(
      runCommand("bash", ["-lc", "trap 'exit 0' TERM; while true; do sleep 0.05; done"], {
        allowFailure: true,
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("returns exit 124 or throws when the overall timeout expires", async () => {
    const request = [process.execPath, ["-e", "setInterval(() => undefined, 1_000)"]] as const;

    await expect(runCommand(request[0], request[1], { timeoutMs: 50 })).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
    expect(
      await runCommand(request[0], request[1], { allowFailure: true, timeoutMs: 50 }),
    ).toMatchObject({ exitCode: 124 });
  });
});
