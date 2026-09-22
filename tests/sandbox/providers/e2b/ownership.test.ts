import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../../../src/artifacts.js";
import { runSandboxWithFailureLog } from "../../../../src/generation/activity-runtime.js";
import { WRAPPER_STATUS_PATH } from "../../../../src/generation/agent/round-outcome.js";
import { LiveSandboxRegistry } from "../../../../src/sandbox/live.js";
import { E2BSandboxExecutor } from "../../../../src/sandbox/providers/e2b/executor.js";
import {
  E2BSdkFixture,
  e2bFixtureConfig,
  fastLifecycleTimings,
} from "../../../support/e2b-sdk-fixture.js";

for (const mode of [
  "transport",
  "inactivity",
  "hard-timeout",
  "abort",
  "completed-timeout",
  "completed-abort",
] as const)
  test(`E2B ${mode} preserves supervision ownership failure behind a transport error and completed wrapper`, async () => {
    const root = await mkdtemp(join(tmpdir(), "e2b-ownership-"));
    try {
      const fixture = new E2BSdkFixture();
      const controller = new AbortController();
      const abortReason = new Error("caller stopped");
      if (mode === "transport") fixture.waitError = new Error("transport failed");
      else if (!mode.startsWith("completed")) fixture.holdCommand = true;
      fixture.outputs.set(WRAPPER_STATUS_PATH, Buffer.from("0\n"));
      const executor = new E2BSandboxExecutor(
        e2bFixtureConfig,
        fixture.api,
        undefined,
        fastLifecycleTimings,
        // Keep grace longer than command deadlines without waiting the production 5s.
        new LiveSandboxRegistry(400),
      );
      const failure = await runSandboxWithFailureLog(
        new LocalArtifactStore(root),
        "failure.log",
        () =>
          executor.run(
            {
              runId: "ownership",
              stage: "author",
              command: ["true"],
              timeoutMs: mode.endsWith("timeout") ? 100 : 10000,
              ...(mode === "inactivity" ? { inactivityTimeoutMs: 20 } : {}),
              outputPaths: [WRAPPER_STATUS_PATH],
            },
            {
              signal: controller.signal,
              onLive: async () => {
                if (mode === "abort") controller.abort(abortReason);
                if (mode === "completed-abort") setTimeout(() => controller.abort(abortReason), 30);
                await new Promise(() => {});
              },
            },
          ),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("unresolved supervision");
      const causes: Error[] = [];
      for (
        let cause = failure;
        cause instanceof Error && !causes.includes(cause);
        cause = cause.cause
      )
        causes.push(cause);
      const ownership = causes.find(
        (cause) => "ownershipFailure" in cause && cause.ownershipFailure === true,
      );
      expect(ownership).toBeDefined();
      expect(
        ownership && "supervisionError" in ownership && ownership.supervisionError,
      ).toBeInstanceOf(Error);
      if (mode.endsWith("abort")) expect(causes).toContain(abortReason);
      if (mode === "transport")
        expect(causes.some((cause) => cause === fixture.waitError)).toBe(true);
      if (mode === "inactivity")
        expect(causes.some((cause) => cause.name === "InactivityTimeoutError")).toBe(true);
      if (mode.endsWith("timeout"))
        expect(causes.some((cause) => cause.name === "TimeoutError")).toBe(true);
      const log = await new LocalArtifactStore(root).getByKey("failure.log");
      if (mode.endsWith("abort"))
        expect(log).toBeUndefined(); // Caller cancellation propagates without diagnostic recovery.
      else expect(log).toBeDefined();
      expect(fixture.allocationExists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
