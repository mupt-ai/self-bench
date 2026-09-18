import { expect, test } from "bun:test";
import { LiveSandboxRegistry } from "../../../../src/sandbox/live.js";
import { hasOwnershipFailure } from "../../../../src/sandbox/ownership.js";
import { VercelSandboxExecutor } from "../../../../src/sandbox/providers/vercel/executor.js";
import { VercelSdkFixture, vercelFixtureConfig } from "../../../support/vercel-sdk-fixture.js";

for (const mode of ["timeout", "abort", "held-timeout", "held-abort"] as const)
  test(`Vercel completed command retains ${mode} supervision ownership`, async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = 0;
    if (mode.startsWith("held")) fixture.logsMode = "hold";
    const controller = new AbortController();
    const reason = new Error("caller abort");
    const error = await new VercelSandboxExecutor(
      vercelFixtureConfig,
      fixture.fetch,
      undefined,
      // Keep grace longer than command deadlines without waiting the production 5s.
      new LiveSandboxRegistry(400),
    )
      .run(
        {
          runId: "ownership",
          stage: "author",
          command: ["true"],
          timeoutMs: mode.endsWith("timeout") ? 200 : 10000,
        },
        {
          signal: controller.signal,
          onLive: async () => {
            if (mode.endsWith("abort")) setTimeout(() => controller.abort(reason), 30);
            await new Promise(() => {});
          },
        },
      )
      .catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(hasOwnershipFailure(error)).toBe(true);
    expect(error.supervisionError).toBeInstanceOf(Error);
    if (mode.endsWith("timeout")) expect(error.cause.name).toBe("TimeoutError");
    expect(fixture.sandboxExists).toBe(false);
    if (mode.endsWith("abort")) expect(error.cause).toBe(reason);
  }, 15000);
