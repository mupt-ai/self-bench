import { describe, expect, test } from "bun:test";
import { SandboxExecutionError } from "../../../../src/sandbox/contracts.js";
import { E2BSandboxExecutor } from "../../../../src/sandbox/providers/e2b/executor.js";
import {
  e2bFixtureConfig as config,
  E2BSdkFixture,
  fastLifecycleTimings,
} from "../../../support/e2b-sdk-fixture.js";

describe("E2BSandboxExecutor basics", () => {
  test("runs with isolated creation, exact inputs, streaming, outputs, and cleanup", async () => {
    const fixture = new E2BSdkFixture();
    fixture.outputs.set("/work/result.bin", Uint8Array.from([0, 255, 1]));
    fixture.outputs.set("/work/empty.bin", new Uint8Array());
    const executor = new E2BSandboxExecutor(config, fixture.api);
    const progress: Array<{ stream: "stdout" | "stderr"; bytes: number }> = [];
    const backing = Uint8Array.from([9, 0, 1, 2, 8]);

    const result = await executor.run(
      {
        runId: "run-e2b",
        stage: "author",
        command: ["node", "script.js", "space value", "quote'value", ""],
        files: [
          { path: "/work/input.bin", contents: backing.subarray(1, 4) },
          { path: "/work/unicode.txt", contents: "héllo 🌍" },
        ],
        outputPaths: ["/work/result.bin", "/work/empty.bin", "/work/missing-after-nonzero"],
        environment: {
          SHARED: "ordinary",
          EMPTY: "",
          E2B_DOMAIN: "do-not-leak",
          E2B_FUTURE_CONTROL: "do-not-leak-either",
        },
        secrets: {
          SHARED: "secret",
          API_KEY: "workload-only",
          E2B_API_KEY: "do-not-leak",
        },
        timeoutMs: 60_000,
        inactivityTimeoutMs: 10_000,
        cpu: 4,
        memoryMiB: 8192,
      },
      { onProgress: (event) => progress.push(event) },
    );

    expect(result).toEqual({
      sandboxId: "sb-e2b-test",
      exitCode: 7,
      stdout: "hello world\n",
      stderr: "warning\n",
      outputs: {
        "/work/result.bin": Uint8Array.from([0, 255, 1]),
        "/work/empty.bin": new Uint8Array(),
      },
    });
    expect(progress).toEqual([
      { stream: "stdout", bytes: 6 },
      { stream: "stdout", bytes: 6 },
      { stream: "stderr", bytes: 8 },
    ]);
    expect(fixture.uploadedFiles.get("/work/input.bin")).toEqual(Uint8Array.from([0, 1, 2]));
    expect(Buffer.from(fixture.uploadedFiles.get("/work/unicode.txt") ?? []).toString()).toBe(
      "héllo 🌍",
    );
    expect(fixture.command).toBe("'node' 'script.js' 'space value' 'quote'\"'\"'value' ''");
    expect(fixture.commandOptions).toMatchObject({
      background: true,
      cwd: "/work",
      timeoutMs: 60_000,
      envs: { SHARED: "secret", EMPTY: "", API_KEY: "workload-only" },
    });
    expect(JSON.stringify(fixture.commandOptions)).not.toContain("e2b_test_key");
    expect(fixture.createOptions).toMatchObject({
      lifecycle: { onTimeout: "kill" },
      timeoutMs: 60_000,
      metadata: {
        selfbench_run: "run-e2b",
        selfbench_stage: "author",
        selfbench_allocation: expect.any(String),
      },
    });
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
    expect(fixture.allocationExists).toBe(false);
  });
  test("rejects invalid paths and resource values before allocation", async () => {
    const fixture = new E2BSdkFixture();
    const executor = new E2BSandboxExecutor(config, fixture.api);

    await expect(
      executor.run({
        runId: "invalid",
        stage: "path",
        command: ["true"],
        files: [{ path: "/work/../secret", contents: "no" }],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("sandbox path must be beneath /work");
    await expect(
      executor.run({
        runId: "invalid",
        stage: "cpu",
        command: ["true"],
        timeoutMs: 1_000,
        cpu: 0,
      }),
    ).rejects.toThrow("CPU must be a positive integer");
    expect(fixture.calls).toEqual([]);
  });
  test("validates template resources after allocation and always cleans up", async () => {
    const fixture = new E2BSdkFixture();
    fixture.memoryMB = 4096;
    const executor = new E2BSandboxExecutor(config, fixture.api);

    await expect(
      executor.run({ runId: "resource", stage: "author", command: ["true"], timeoutMs: 1_000 }),
    ).rejects.toThrow("allocated 4 CPU/4096 MiB");
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });
  test("preserves partial logs and outputs when remote execution fails", async () => {
    const fixture = new E2BSdkFixture();
    fixture.waitError = new Error("transport failed");
    fixture.outputs.set("/work/partial.json", Buffer.from('{"status":"partial"}'));
    const executor = new E2BSandboxExecutor(config, fixture.api);

    try {
      await executor.run({
        runId: "failure",
        stage: "review",
        command: ["false"],
        outputPaths: ["/work/partial.json"],
        timeoutMs: 1_000,
      });
      throw new Error("expected execution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxExecutionError);
      expect(error).toMatchObject({
        result: {
          sandboxId: "sb-e2b-test",
          exitCode: 1,
          stdout: "hello world\n",
          stderr: "warning\n",
          outputs: { "/work/partial.json": Buffer.from('{"status":"partial"}') },
        },
      });
      expect(String(error)).toContain("transport failed");
    }
    expect(fixture.calls.indexOf("command.kill")).toBeLessThan(
      fixture.calls.indexOf("files.read:/work/partial.json"),
    );
    expect(fixture.calls.indexOf("files.read:/work/partial.json")).toBeLessThan(
      fixture.calls.indexOf("sandbox.kill"),
    );
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });
  test("retains buffered command output when stream callbacks deliver nothing", async () => {
    const fixture = new E2BSdkFixture();
    fixture.streamOutput = false;
    fixture.exitCode = 0;

    const result = await new E2BSandboxExecutor(config, fixture.api).run({
      runId: "buffered-output",
      stage: "author",
      command: ["true"],
      timeoutMs: 1_000,
    });

    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("warning\n");
  });
  test("preserves partial outputs when command start fails", async () => {
    const fixture = new E2BSdkFixture();
    fixture.commandRunError = new Error("command start failed");
    fixture.outputs.set("/work/partial.json", Buffer.from("partial"));

    try {
      await new E2BSandboxExecutor(config, fixture.api).run({
        runId: "start-failure",
        stage: "review",
        command: ["false"],
        outputPaths: ["/work/partial.json"],
        timeoutMs: 1_000,
      });
      throw new Error("expected execution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxExecutionError);
      expect((error as SandboxExecutionError).result.outputs["/work/partial.json"]).toEqual(
        Buffer.from("partial"),
      );
      expect(String(error)).toContain("command start failed");
    }
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });
  test("does not allocate when cancellation is already requested", async () => {
    const fixture = new E2BSdkFixture();
    const executor = new E2BSandboxExecutor(config, fixture.api);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before run"));

    await expect(
      executor.run(
        { runId: "cancelled", stage: "author", command: ["true"], timeoutMs: 1_000 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled before run");
    expect(fixture.calls).toEqual([]);
  });
  test("settles cancellation during create even when create ignores abort", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCreate = true;
    fixture.ignoreCreateAbort = true;
    fixture.listMatchesAllocation = true;
    fixture.listState = "paused";
    const executor = new E2BSandboxExecutor(
      config,
      fixture.api,
      async (_delayMs, signal) => signal.throwIfAborted(),
      fastLifecycleTimings,
    );
    const controller = new AbortController();

    const failure = executor.run(
      { runId: "cancel-create", stage: "author", command: ["true"], timeoutMs: 1_000 },
      { signal: controller.signal },
    );
    await Bun.sleep(0);
    controller.abort(new Error("cancelled while creating"));

    await expect(failure).rejects.toThrow("cancelled while creating");
    expect(fixture.calls).toContain("Sandbox.kill:sb-late-e2b");
    expect(fixture.listOptions).not.toHaveProperty("state");
    expect(fixture.allocationExists).toBe(false);
  });
  test("cleans up a create handle that arrives after local cancellation", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCreate = true;
    fixture.ignoreCreateAbort = true;
    const controller = new AbortController();
    const executor = new E2BSandboxExecutor(
      config,
      fixture.api,
      async (delayMs, signal) => {
        signal.throwIfAborted();
        if (delayMs > 0) {
          fixture.releaseCreate();
          await Bun.sleep(0);
        }
      },
      fastLifecycleTimings,
    );

    const failure = executor.run(
      { runId: "late-create", stage: "author", command: ["true"], timeoutMs: 1_000 },
      { signal: controller.signal },
    );
    await Bun.sleep(0);
    controller.abort(new Error("cancel before create response"));

    await expect(failure).rejects.toThrow("cancel before create response");
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.allocationExists).toBe(false);
  });
});
