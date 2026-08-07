import { describe, expect, test } from "bun:test";
import type { ModalClient } from "modal";
import { ModalSandboxExecutor } from "../src/modal-executor.js";

describe("ModalSandboxExecutor", () => {
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
