import { describe, expect, test } from "bun:test";
import { AuthenticationError, SandboxNotFoundError } from "e2b";
import { SandboxExecutionError } from "../../../../src/sandbox/contracts.js";
import { E2BSandboxExecutor } from "../../../../src/sandbox/providers/e2b/executor.js";
import {
  e2bFixtureConfig as config,
  E2BSdkFixture,
  fastLifecycleTimings,
} from "../../../support/e2b-sdk-fixture.js";

describe("E2BSandboxExecutor cleanup", () => {
  test("recovers an ambiguous create by allocation metadata", async () => {
    const fixture = new E2BSdkFixture();
    fixture.createError = new Error("lost create response");
    fixture.listMatchesAllocation = true;
    const sleeps: number[] = [];
    const executor = new E2BSandboxExecutor(config, fixture.api, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    await expect(
      executor.run({ runId: "ambiguous", stage: "author", command: ["true"], timeoutMs: 1_000 }),
    ).rejects.toThrow("lost create response");
    expect(fixture.calls).toContain("Sandbox.kill:sb-late-e2b");
    expect(sleeps).toEqual([]);
    expect(fixture.allocationExists).toBe(false);
  });
  test("does not attempt allocation recovery for an authentication rejection", async () => {
    const fixture = new E2BSdkFixture();
    fixture.createError = new AuthenticationError("invalid API key");

    await expect(
      new E2BSandboxExecutor(config, fixture.api).run({
        runId: "auth-rejected",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("invalid API key");
    expect(fixture.calls).not.toContain("Sandbox.list");
    expect(fixture.calls).not.toContain("Sandbox.kill:sb-late-e2b");
  });
  test("confirms absence even when handle kill reports success", async () => {
    const fixture = new E2BSdkFixture();
    fixture.instanceKillRemovesAllocation = false;
    const executor = new E2BSandboxExecutor(config, fixture.api);

    await expect(
      executor.run({
        runId: "optimistic-handle-kill",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ exitCode: 7 });
    expect(fixture.calls).toContain("Sandbox.getInfo:sb-e2b-test");
    expect(fixture.calls).toContain("Sandbox.kill:sb-e2b-test");
    expect(fixture.allocationExists).toBe(false);
  });
  test("does not treat a false kill result as confirmation without checking absence", async () => {
    const fallback = new E2BSdkFixture();
    fallback.instanceKillResult = false;
    await expect(
      new E2BSandboxExecutor(config, fallback.api).run({
        runId: "fallback-kill",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ exitCode: 7 });
    expect(fallback.calls).toContain("Sandbox.kill:sb-e2b-test");
    expect(fallback.allocationExists).toBe(false);

    const alreadyAbsent = new E2BSdkFixture();
    alreadyAbsent.instanceKillError = new Error("instance transport failed");
    alreadyAbsent.staticKillResult = false;
    alreadyAbsent.staticGetInfoError = new SandboxNotFoundError("Sandbox not found");
    await expect(
      new E2BSandboxExecutor(config, alreadyAbsent.api).run({
        runId: "already-absent",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ exitCode: 7 });
    expect(alreadyAbsent.calls).toContain("Sandbox.getInfo:sb-e2b-test");
  });
  test("fails cleanup when kill returns false and the sandbox still exists", async () => {
    const fixture = new E2BSdkFixture();
    fixture.instanceKillResult = false;
    fixture.staticKillResult = false;
    const executor = new E2BSandboxExecutor(
      config,
      fixture.api,
      async (_delayMs, signal) => {
        signal.throwIfAborted();
      },
      fastLifecycleTimings,
    );

    const failure = executor.run({
      runId: "cleanup-unconfirmed",
      stage: "author",
      command: ["true"],
      timeoutMs: 1_000,
    });

    await expect(failure).rejects.toMatchObject({ name: "E2BSandboxCleanupError" });
    await expect(failure).rejects.toThrow("still exists after repeated kill requests");
    expect(fixture.calls.filter((call) => call === "Sandbox.getInfo:sb-e2b-test")).toHaveLength(3);
    expect(fixture.allocationExists).toBe(true);
  });
  test("bounds a stuck handle kill and falls back to static cleanup", async () => {
    const fixture = new E2BSdkFixture();
    fixture.instanceKillHangs = true;
    const executor = new E2BSandboxExecutor(config, fixture.api, undefined, fastLifecycleTimings);

    await expect(
      executor.run({
        runId: "stuck-handle-kill",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ exitCode: 7 });
    expect(fixture.calls).toContain("Sandbox.kill:sb-e2b-test");
    expect(fixture.allocationExists).toBe(false);
  });
  test("fails when a successful command omits a required output", async () => {
    const fixture = new E2BSdkFixture();
    fixture.exitCode = 0;

    await expect(
      new E2BSandboxExecutor(config, fixture.api, async () => undefined).run({
        runId: "missing-output",
        stage: "author",
        command: ["true"],
        outputPaths: ["/work/required.json"],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("exited successfully without output /work/required.json");
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });
  test("falls back to static cleanup and redacts control credentials from cleanup errors", async () => {
    const fixture = new E2BSdkFixture();
    fixture.instanceKillError = new Error("instance kill failed");
    fixture.staticKillError = new Error(`static kill failed with ${config.credentials.apiKey}`);
    const executor = new E2BSandboxExecutor(config, fixture.api);

    const failure = executor.run({
      runId: "cleanup",
      stage: "author",
      command: ["true"],
      timeoutMs: 1_000,
    });

    await expect(failure).rejects.toMatchObject({ name: "E2BSandboxCleanupError" });
    await expect(failure).rejects.toThrow("[redacted]");
    await expect(failure).rejects.not.toThrow(config.credentials.apiKey);
    expect(fixture.calls).toContain("Sandbox.kill:sb-e2b-test");
  });
  test("attaches a redacted cleanup failure to the primary execution error", async () => {
    const fixture = new E2BSdkFixture();
    fixture.waitError = new Error("execution transport failed");
    fixture.instanceKillError = new Error("instance kill failed");
    fixture.staticKillError = new Error(`static cleanup exposed ${config.credentials.apiKey}`);
    const failure = new E2BSandboxExecutor(config, fixture.api).run({
      runId: "execution-and-cleanup-fail",
      stage: "author",
      command: ["false"],
      timeoutMs: 1_000,
    });

    await expect(failure).rejects.toBeInstanceOf(SandboxExecutionError);
    await expect(failure).rejects.toThrow("execution transport failed");
    await expect(failure).rejects.toThrow("cleanup also failed");
    await expect(failure).rejects.toThrow("[redacted]");
    await expect(failure).rejects.not.toThrow(config.credentials.apiKey);
    const error = (await failure.catch((caught) => caught)) as Error & { cleanupError?: Error };
    expect(error.cleanupError?.name).toBe("E2BSandboxCleanupError");
  });
});
