import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { CancelledFailure, Context } from "@temporalio/activity";
import type { ArtifactStore } from "../src/artifacts.js";
import { SandboxExecutionError } from "../src/sandbox/contracts.js";
import { LiveSandboxRegistry, SandboxSupervisionError } from "../src/sandbox/live.js";
import { WRAPPER_STATUS_PATH } from "../src/temporal/activities/round-outcome.js";
import {
  runSandboxWithFailureLog,
  withActivityHeartbeats,
} from "../src/temporal/activities/runtime.js";
import { artifact } from "./support/workflow-fixture.js";

afterEach(() => mock.restore());

function context() {
  const controller = new AbortController();
  spyOn(Context, "current").mockReturnValue({
    cancellationSignal: controller.signal,
    heartbeat: () => {},
  } as unknown as Context);
  return controller;
}

for (const source of ["command", "activity"] as const) {
  test(`heartbeats forward ${source} cancellation and reject a late successful action`, async () => {
    const activity = context();
    const command = new AbortController();
    let release!: () => void;
    let received: AbortSignal | undefined;
    const pending = withActivityHeartbeats(
      "test",
      async ({ signal }) => {
        received = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "late success";
      },
      command.signal,
    );
    const reason = new Error(`${source} cancelled`);
    (source === "command" ? command : activity).abort(reason);
    expect(received?.aborted).toBe(true);
    release();
    if (source === "command") await expect(pending).rejects.toBe(reason);
    else await expect(pending).rejects.toBeInstanceOf(CancelledFailure);
  });
}

test("a pre-aborted command never starts another activity child", async () => {
  context();
  const signal = AbortSignal.abort(new Error("command ended"));
  let called = false;
  await expect(
    withActivityHeartbeats(
      "test",
      async () => {
        called = true;
      },
      signal,
    ),
  ).rejects.toThrow("command ended");
  expect(called).toBe(false);
});

test("actual uncooperative supervision timeout cannot recover wrapper success through a provider cause", async () => {
  const registry = new LiveSandboxRegistry(10);
  const supervision = registry.start(
    "owned",
    {
      execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: async () => undefined,
      writeFile: async () => {},
    },
    { onLive: () => new Promise(() => {}) },
  );
  let ownership: unknown;
  try {
    await supervision.finish();
  } catch (error) {
    ownership = error;
  }
  expect(ownership).toBeInstanceOf(SandboxSupervisionError);
  const result = {
    sandboxId: "owned",
    exitCode: 1,
    stdout: "partial stdout",
    stderr: "",
    outputs: { [WRAPPER_STATUS_PATH]: Buffer.from("0\n") },
  };
  const providerError = new SandboxExecutionError("provider failed", result, {
    cause: new Error("intermediate SDK wrapper", { cause: ownership }),
  });
  const logs: string[] = [];
  const store = {
    put: async (key: string) => {
      logs.push(key);
      return artifact;
    },
  } as unknown as ArtifactStore;
  let failure: unknown;
  try {
    await runSandboxWithFailureLog(store, "partial.log", async () => {
      throw providerError;
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe(providerError);
  expect(logs).toEqual(["partial.log"]);
});

test("ordinary post-wrapper diagnostics remain recoverable even with cyclic causes", async () => {
  const error = new SandboxExecutionError("diagnostic", {
    sandboxId: "owned",
    exitCode: 1,
    stdout: "",
    stderr: "",
    outputs: { [WRAPPER_STATUS_PATH]: Buffer.from("0\n") },
  });
  error.cause = error;
  const store = {
    put: async () => {
      throw new Error("should not persist failure");
    },
  } as unknown as ArtifactStore;
  expect(
    (
      await runSandboxWithFailureLog(store, "unused", async () => {
        throw error;
      })
    ).exitCode,
  ).toBe(0);
});
