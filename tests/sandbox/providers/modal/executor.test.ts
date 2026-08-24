import { describe, expect, test } from "bun:test";
import type { ModalClient } from "modal";
import { SandboxExecutionError } from "../../../../src/sandbox/contracts.js";
import { ModalSandboxExecutor } from "../../../../src/sandbox/providers/modal/executor.js";

describe("ModalSandboxExecutor", () => {
  test("preserves partial output and sandbox identity when execution throws", async () => {
    const stream = (value: string, delayedValue?: string, remainOpen = false) =>
      new ReadableStream<string>({
        async start(controller) {
          controller.enqueue(value);
          if (delayedValue) {
            await Bun.sleep(10);
            controller.enqueue(delayedValue);
          }
          if (!remainOpen) {
            controller.close();
          }
        },
      });
    const sandbox = {
      sandboxId: "sb-failed",
      filesystem: {
        writeText: async () => undefined,
        writeBytes: async () => undefined,
        readBytes: async (path: string) =>
          path === "/work/partial.json"
            ? Buffer.from('{"status":"partial"}')
            : Promise.reject(new Error("missing output")),
      },
      exec: async () => ({
        closeStdin: async () => undefined,
        stdout: stream("partial stdout", " after failure", true),
        stderr: stream("partial stderr"),
        wait: async () => {
          throw new Error("transport failed");
        },
      }),
      terminate: async () => undefined,
    };
    const client = {
      apps: { fromName: async () => ({}) },
      images: { fromRegistry: () => ({ dockerfileCommands: () => ({}) }) },
      sandboxes: { create: async () => sandbox },
      secrets: { fromObject: async () => ({}) },
      close: () => undefined,
    } as unknown as ModalClient;
    const executor = new ModalSandboxExecutor(
      { kind: "modal", app: "selfbench", image: "node:22-bookworm" },
      client,
    );

    try {
      await executor.run({
        runId: "modal-test",
        stage: "failed-probe",
        timeoutMs: 1_000,
        command: ["false"],
        outputPaths: ["/work/partial.json"],
      });
      throw new Error("expected execution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxExecutionError);
      const executionError = error as SandboxExecutionError;
      expect(executionError.message).toContain("sandbox sb-failed");
      expect(executionError.result).toEqual({
        sandboxId: "sb-failed",
        exitCode: 1,
        stdout: "partial stdout after failure",
        stderr: "partial stderr",
        outputs: { "/work/partial.json": Buffer.from('{"status":"partial"}') },
      });
    }
  });

  test("does not allocate a sandbox when cancellation is already requested", async () => {
    let allocations = 0;
    const client = {
      apps: { fromName: async () => ({}) },
      images: { fromRegistry: () => ({ dockerfileCommands: () => ({}) }) },
      sandboxes: {
        create: async () => {
          allocations += 1;
          throw new Error("unexpected sandbox allocation");
        },
      },
      secrets: { fromObject: async () => ({}) },
      close: () => undefined,
    } as unknown as ModalClient;
    const executor = new ModalSandboxExecutor(
      { kind: "modal", app: "selfbench", image: "node:22-bookworm" },
      client,
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled before run"));

    await expect(
      executor.run(
        { runId: "modal-test", stage: "cancelled-probe", timeoutMs: 1_000, command: ["false"] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled before run");
    expect(allocations).toBe(0);
  });

  test("drains successful output after the process reports completion", async () => {
    const stdout = new ReadableStream<string>({
      async start(controller) {
        await Bun.sleep(20);
        controller.enqueue("late output");
        controller.close();
      },
    });
    const emptyStream = () =>
      new ReadableStream<string>({
        start(controller) {
          controller.close();
        },
      });
    const sandbox = {
      sandboxId: "sb-success",
      filesystem: {
        writeText: async () => undefined,
        writeBytes: async () => undefined,
        readBytes: async () => new Uint8Array(),
      },
      exec: async () => ({
        closeStdin: async () => undefined,
        stdout,
        stderr: emptyStream(),
        wait: async () => 0,
      }),
      terminate: async () => undefined,
    };
    const client = {
      apps: { fromName: async () => ({}) },
      images: { fromRegistry: () => ({ dockerfileCommands: () => ({}) }) },
      sandboxes: { create: async () => sandbox },
      secrets: { fromObject: async () => ({}) },
      close: () => undefined,
    } as unknown as ModalClient;
    const executor = new ModalSandboxExecutor(
      { kind: "modal", app: "selfbench", image: "node:22-bookworm" },
      client,
    );

    const result = await executor.run({
      runId: "modal-test",
      stage: "success-probe",
      timeoutMs: 1_000,
      command: ["true"],
    });

    expect(result.stdout).toBe("late output");
  });

  test("closes process stdin before waiting for completion", async () => {
    let stdinClosed = false;
    const emptyStream = () =>
      new ReadableStream<string>({
        start(controller) {
          controller.close();
        },
      });
    const sandbox = {
      sandboxId: "sb-test",
      filesystem: {
        writeText: async () => undefined,
        writeBytes: async () => undefined,
        readBytes: async () => new Uint8Array(),
      },
      exec: async () => ({
        closeStdin: async () => {
          stdinClosed = true;
        },
        stdout: emptyStream(),
        stderr: emptyStream(),
        wait: async () => {
          expect(stdinClosed).toBe(true);
          return 0;
        },
      }),
      terminate: async () => undefined,
    };
    const client = {
      apps: { fromName: async () => ({}) },
      images: {
        fromRegistry: () => ({ dockerfileCommands: () => ({}) }),
      },
      sandboxes: { create: async () => sandbox },
      secrets: { fromObject: async () => ({}) },
      close: () => undefined,
    } as unknown as ModalClient;
    const executor = new ModalSandboxExecutor(
      { kind: "modal", app: "selfbench", image: "node:22-bookworm" },
      client,
    );

    const result = await executor.run({
      runId: "modal-test",
      stage: "probe",
      timeoutMs: 1_000,
      command: ["true"],
    });

    expect(result.exitCode).toBe(0);
    expect(stdinClosed).toBe(true);
  });
});
