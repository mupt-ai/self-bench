import { expect } from "bun:test";
import type { ModalClient } from "modal";
import type { SandboxRequest } from "../../../../src/sandbox/contracts.js";
import { ModalSandboxExecutor } from "../../../../src/sandbox/providers/modal/executor.js";
import type { ModalCleanupError } from "../../../../src/sandbox/providers/modal/lifecycle.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const never = <T>(): Promise<T> => new Promise(() => {});
const empty = () => new ReadableStream<string>({ start: (controller) => controller.close() });
export const request: SandboxRequest = {
  runId: "run",
  stage: "stage",
  timeoutMs: 100,
  command: ["true"],
};
export function fixture() {
  let terminated = 0;
  let executed = 0;
  let lookup: unknown[] = [];
  let createName = "";
  const process = {
    closeStdin: async () => {},
    stdout: empty(),
    stderr: empty(),
    wait: async () => 0,
  };
  const sandbox = {
    sandboxId: "sb-owned",
    filesystem: {
      writeText: async (_contents: string, _path: string) => {},
      writeBytes: async () => {},
      readBytes: async (_path: string): Promise<Uint8Array> => Buffer.from("output"),
    },
    exec: async () => {
      executed++;
      return process;
    },
    terminate: async (params: { wait: true }) => {
      expect(params).toEqual({ wait: true });
      terminated++;
      return 0;
    },
  };
  const client = {
    apps: { fromName: async () => ({}) },
    images: { fromRegistry: () => ({ dockerfileCommands: () => ({}) }) },
    secrets: { fromObject: async () => ({}) },
    sandboxes: {
      create: async (_app: unknown, _image: unknown, params: { name?: string }) => {
        createName = params.name ?? "";
        return sandbox;
      },
      fromName: async (...args: unknown[]) => {
        lookup = args;
        return sandbox;
      },
    },
    close: () => {},
  };
  return {
    sandbox,
    process,
    client,
    executor: () =>
      new ModalSandboxExecutor(
        { kind: "modal", app: "test-app", image: "test-image", environment: "test-env" },
        client as unknown as ModalClient,
        30,
      ),
    state: () => ({ terminated, executed, lookup, createName }),
  };
}
export async function failure(
  promise: Promise<unknown>,
): Promise<Error & { cleanupError?: ModalCleanupError }> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected rejection");
}
