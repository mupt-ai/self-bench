import { describe, expect, test } from "bun:test";
import { InactivityTimeoutError } from "../../../../src/process.js";
import { VercelSandboxExecutor } from "../../../../src/sandbox/providers/vercel/executor.js";
import {
  vercelFixtureConfig as config,
  VercelSdkFixture,
} from "../../../support/vercel-sdk-fixture.js";

describe("VercelSandboxExecutor lifecycle", () => {
  test("cancels creation after allocation and recovers the sandbox by exact name", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createHoldsAfterAllocation = true;
    let notifyAllocated = (): void => {};
    const allocated = new Promise<void>((resolve) => {
      notifyAllocated = resolve;
    });
    fixture.onCreateAllocated = notifyAllocated;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);
    const controller = new AbortController();

    const failure = executor.run(
      {
        runId: "cancel-during-create",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      },
      { signal: controller.signal },
    );
    await allocated;
    controller.abort(new Error("cancelled while create response was pending"));

    await expect(failure).rejects.toThrow("cancelled while create response was pending");
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.sandboxExists).toBe(false);
  });
  test("deletes the whole sandbox and reports output inactivity", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = null;
    fixture.logsMode = "hold";
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const failure = executor.run({
      runId: "inactivity",
      stage: "review",
      command: ["node", "script.js"],
      timeoutMs: 60_000,
      inactivityTimeoutMs: 20,
    });

    await expect(failure).rejects.toBeInstanceOf(InactivityTimeoutError);
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(true);
  });
  test("resets output inactivity only when nonempty output arrives", async () => {
    const fixture = new VercelSdkFixture();
    fixture.logsMode = "periodic";
    const progress: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const result = await executor.run(
      {
        runId: "periodic-output",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
        inactivityTimeoutMs: 25,
      },
      { onProgress: ({ bytes }) => progress.push(bytes) },
    );

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("tick-1\ntick-2\ntick-3\ntick-4\n");
    expect(progress).toEqual([7, 7, 7, 7]);
  });
  test("stops output inactivity timing before bounded completion settlement", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandStatusDelayMs = 30;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const result = await executor.run({
      runId: "completion-settlement",
      stage: "author",
      command: ["true"],
      timeoutMs: 1_000,
      inactivityTimeoutMs: 10,
    });

    expect(result.exitCode).toBe(7);
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
  });
  test("does not treat empty log events as output activity", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = null;
    fixture.logsMode = "empty-pulse";
    const progress: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const failure = executor.run(
      {
        runId: "empty-output",
        stage: "author",
        command: ["true"],
        timeoutMs: 200,
        inactivityTimeoutMs: 30,
      },
      { onProgress: ({ bytes }) => progress.push(bytes) },
    );

    await expect(failure).rejects.toBeInstanceOf(InactivityTimeoutError);
    expect(progress).toEqual([]);
  });
  test("honors cancellation triggered by streamed progress and deletes the sandbox", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = null;
    fixture.logsMode = "one-then-hold";
    const executor = new VercelSandboxExecutor(config, fixture.fetch);
    const controller = new AbortController();

    const failure = executor.run(
      {
        runId: "cancel-progress",
        stage: "author",
        command: ["node", "script.js"],
        timeoutMs: 60_000,
      },
      {
        signal: controller.signal,
        onProgress: () => controller.abort(new Error("cancelled from progress")),
      },
    );

    await expect(failure).rejects.toThrow("cancelled from progress");
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(true);
  });
  test("enforces an overall hard timeout even when the provider never settles", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = null;
    fixture.logsMode = "one-then-hold";
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const result = await executor.run({
      runId: "hard-timeout",
      stage: "author",
      command: ["node", "script.js"],
      timeoutMs: 100,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("first\n");
    expect(result.stderr).toBe("");
    expect(result.outputs).toEqual({});
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(true);
  });
  test("returns a hard-timeout result and recovers allocation while create is pending", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createHoldsAfterAllocation = true;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const result = await executor.run({
      runId: "hard-timeout-during-create",
      stage: "author",
      command: ["true"],
      timeoutMs: 100,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.sandboxExists).toBe(false);
  });
  test("recovers a failed direct delete by exact name without resuming", async () => {
    const fixture = new VercelSdkFixture();
    fixture.deleteFailuresRemaining = 1;
    const sleeps: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    const result = await executor.run({
      runId: "cleanup-recovery",
      stage: "author",
      command: ["true"],
      timeoutMs: 60_000,
    });

    expect(result.exitCode).toBe(7);
    expect(sleeps).toEqual([1_000]);
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
    const get = fixture.calls.find(
      (call) =>
        call.method === "GET" && call.path.startsWith(`/api/v2/sandboxes/${fixture.sandboxName}?`),
    );
    expect(get?.path).toContain("resume=false");
  });
  test("deletes a late-visible sandbox after losing its create response", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createFailsAfterAllocation = true;
    fixture.getNotFoundResponsesRemaining = 1;
    const sleeps: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    await expect(
      executor.run({
        runId: "late-create",
        stage: "cancelled",
        command: ["true"],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("simulated lost create response");

    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path.startsWith(`/api/v2/sandboxes/${fixture.sandboxName}?`),
      ),
    ).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(sleeps).toEqual([250]);
  });
  test("fails cleanup when an ambiguous create never becomes visible", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createFailsAfterAllocation = true;
    fixture.getNotFoundResponsesRemaining = 4;
    const sleeps: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    let failure: unknown;
    try {
      await executor.run({
        runId: "hidden-create",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: "AbortError" });
    expect(String(failure)).toContain("simulated lost create response");
    expect(String(failure)).toContain("Vercel sandbox cleanup also failed");
    expect(String(failure)).toContain(
      "sandbox absence remained unconfirmed after an ambiguous create failure",
    );
    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path.startsWith(`/api/v2/sandboxes/${fixture.sandboxName}?`),
      ),
    ).toHaveLength(4);
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(fixture.sandboxExists).toBe(true);
    expect(sleeps).toEqual([250, 750, 1_500]);
  });
  test("retains the primary failure while surfacing a cleanup failure", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandStartStatus = 503;
    fixture.deleteFailuresRemaining = 1;
    fixture.getFails = true;
    fixture.getFailureMessage = `simulated cleanup failure with ${config.credentials.token}`;
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (_delayMs, signal) => {
      signal.throwIfAborted();
    });

    let failure: unknown;
    try {
      await executor.run({
        runId: "dual-failure",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ name: "VercelCommandStartError" });
    const publicMessage = String(failure);
    expect(publicMessage).toContain("Vercel sandbox cleanup also failed");
    expect(publicMessage).toContain("failed to delete Vercel sandbox");
    expect(publicMessage).toContain("[redacted]");
    expect(publicMessage).not.toContain(config.credentials.token);
    const attachedCleanup = (failure as Error & { cleanupError?: unknown }).cleanupError;
    expect(String(attachedCleanup)).toContain("[redacted]");
    expect(String(attachedCleanup)).not.toContain(config.credentials.token);
  });
});
