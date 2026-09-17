import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../../../src/artifacts.js";
import { E2BSandboxExecutor } from "../../../../src/sandbox/providers/e2b/executor.js";
import { WRAPPER_STATUS_PATH } from "../../../../src/temporal/activities/round-outcome.js";
import { runSandboxWithFailureLog } from "../../../../src/temporal/activities/runtime.js";
import {
  E2BSdkFixture,
  e2bFixtureConfig,
  fastLifecycleTimings,
} from "../../../support/e2b-sdk-fixture.js";

for (const mode of ["transport", "inactivity"] as const)
  test(`E2B ${mode} preserves supervision ownership failure behind a transport error and completed wrapper`, async () => {
    const root = await mkdtemp(join(tmpdir(), "e2b-ownership-"));
    try {
      const fixture = new E2BSdkFixture();
      if (mode === "transport") fixture.waitError = new Error("transport failed");
      else fixture.holdCommand = true;
      fixture.outputs.set(WRAPPER_STATUS_PATH, Buffer.from("0\n"));
      const executor = new E2BSandboxExecutor(
        e2bFixtureConfig,
        fixture.api,
        undefined,
        fastLifecycleTimings,
      );
      await expect(
        runSandboxWithFailureLog(new LocalArtifactStore(root), "failure.log", () =>
          executor.run(
            {
              runId: "ownership",
              stage: "author",
              command: ["true"],
              timeoutMs: 10000,
              ...(mode === "inactivity" ? { inactivityTimeoutMs: 20 } : {}),
              outputPaths: [WRAPPER_STATUS_PATH],
            },
            {
              onLive: async () => {
                await new Promise(() => {});
              },
            },
          ),
        ),
      ).rejects.toThrow("unresolved supervision");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
