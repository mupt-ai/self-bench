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

  test("lets a stopped child finish its cleanup within killGraceMs before SIGKILL", async () => {
    // Cleans up for ~1s after SIGTERM, then reports it finished; SIGKILL cuts that short.
    const script = "trap 'sleep 1; echo cleaned; exit 0' TERM; while true; do sleep 0.05; done";
    const stopped = async (killGraceMs: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      let output = "";
      await runCommand("bash", ["-c", script], {
        signal: controller.signal,
        killGraceMs,
        onOutput: (_stream, chunk) => {
          output += Buffer.from(chunk).toString("utf8");
        },
      }).catch(() => undefined);
      return output;
    };

    expect(await stopped(5_000)).toContain("cleaned");
    expect(await stopped(200)).not.toContain("cleaned");
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
