import { describe, expect, test } from "bun:test";
import { InactivityTimeoutError } from "../../../../src/process.js";
import { SandboxExecutionError } from "../../../../src/sandbox/contracts.js";
import { E2BSandboxExecutor } from "../../../../src/sandbox/providers/e2b/executor.js";
import {
  e2bFixtureConfig as config,
  E2BSdkFixture,
  fastLifecycleTimings,
} from "../../../support/e2b-sdk-fixture.js";

describe("E2BSandboxExecutor timeouts", () => {
  test("cancels a running command and kills the whole sandbox", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommand = true;
    const executor = new E2BSandboxExecutor(config, fixture.api);
    const controller = new AbortController();

    const failure = executor.run(
      { runId: "cancel", stage: "author", command: ["true"], timeoutMs: 1_000 },
      {
        signal: controller.signal,
        onProgress: () => controller.abort(new Error("cancelled from progress")),
      },
    );

    await expect(failure).rejects.toThrow("cancelled from progress");
    expect(fixture.calls).toContain("sandbox.kill");
  });
  test("reports output inactivity with partial diagnostics", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommand = true;
    const executor = new E2BSandboxExecutor(config, fixture.api);

    try {
      await executor.run({
        runId: "inactive",
        stage: "review",
        command: ["true"],
        timeoutMs: 1_000,
        inactivityTimeoutMs: 20,
      });
      throw new Error("expected inactivity failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxExecutionError);
      expect((error as SandboxExecutionError).cause).toBeInstanceOf(InactivityTimeoutError);
      expect((error as SandboxExecutionError).result.stdout).toBe("hello world\n");
    }
    expect(fixture.calls).toContain("sandbox.kill");
  });
  test("enforces an overall hard timeout without returning partial outputs", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommand = true;
    fixture.outputs.set("/work/partial.json", Buffer.from("partial"));
    const executor = new E2BSandboxExecutor(config, fixture.api);

    const result = await executor.run({
      runId: "hard-timeout",
      stage: "author",
      command: ["true"],
      outputPaths: ["/work/partial.json"],
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      sandboxId: "sb-e2b-test",
      exitCode: 124,
      stdout: "hello world\n",
      stderr: "warning\n",
      outputs: {},
    });
    expect(fixture.calls).toContain("command.kill");
    expect(fixture.calls).toContain("sandbox.kill");
  });
  test("hard timeout settles when command wait and command kill both ignore abort", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommand = true;
    fixture.ignoreCommandAbort = true;
    fixture.commandKillHangs = true;
    fixture.commandKillReleases = false;
    const executor = new E2BSandboxExecutor(config, fixture.api, undefined, fastLifecycleTimings);
    const startedAt = performance.now();

    const result = await executor.run({
      runId: "stuck-wait",
      stage: "author",
      command: ["true"],
      timeoutMs: 100,
    });

    expect(result.exitCode).toBe(124);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(fixture.calls).toContain("command.kill");
    expect(fixture.calls).toContain("sandbox.kill");
  });
  test("hard timeout settles when command start ignores abort", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommandStart = true;
    const executor = new E2BSandboxExecutor(config, fixture.api, undefined, fastLifecycleTimings);

    const result = await executor.run({
      runId: "stuck-command-start",
      stage: "author",
      command: ["true"],
      timeoutMs: 100,
    });

    expect(result.exitCode).toBe(124);
    expect(fixture.calls).not.toContain("command.kill");
    expect(fixture.calls).toContain("sandbox.kill");
  });
  test("bounds partial output reads that ignore abort", async () => {
    const fixture = new E2BSdkFixture();
    fixture.waitError = new Error("transport failed");
    fixture.holdReads = true;
    const executor = new E2BSandboxExecutor(config, fixture.api, undefined, fastLifecycleTimings);
    const startedAt = performance.now();

    const failure = executor.run({
      runId: "stuck-output",
      stage: "review",
      command: ["false"],
      outputPaths: ["/work/one", "/work/two"],
      timeoutMs: 1_000,
    });

    await expect(failure).rejects.toBeInstanceOf(SandboxExecutionError);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(fixture.calls).toContain("files.read:/work/one");
    expect(fixture.calls).toContain("files.read:/work/two");
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });
});
