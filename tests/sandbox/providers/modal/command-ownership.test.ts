import { expect, test } from "bun:test";
import type { ModalClient, Sandbox } from "modal";
import type { ArtifactStore } from "../../../../src/artifacts.js";
import { SandboxExecutionError } from "../../../../src/sandbox/contracts.js";
import { LiveSandboxRegistry, SandboxSupervisionError } from "../../../../src/sandbox/live.js";
import { runModalCommand } from "../../../../src/sandbox/providers/modal/command.js";
import {
  ModalAllocation,
  ModalDeadline,
} from "../../../../src/sandbox/providers/modal/lifecycle.js";
import { WRAPPER_STATUS_PATH } from "../../../../src/temporal/activities/round-outcome.js";
import { runSandboxWithFailureLog } from "../../../../src/temporal/activities/runtime.js";
import { artifact } from "../../../support/workflow-fixture.js";
import { fixture, never, request } from "./fixture.js";

for (const primaryKind of ["process", "stream"] as const) {
  test(`${primaryKind} failure plus actual supervision timeout cannot recover wrapper success`, async () => {
    const f = fixture();
    const primary = new Error(`${primaryKind} transport failed`);
    if (primaryKind === "process")
      f.process.wait = async () => {
        throw primary;
      };
    else
      f.process.stdout = new ReadableStream({
        start(controller) {
          controller.error(primary);
        },
      });
    f.sandbox.filesystem.readBytes = async () => Buffer.from("0\n");
    const allocation = new ModalAllocation(
      f.client as unknown as ModalClient,
      "app",
      "owned",
      undefined,
      30,
    );
    const deadline = new ModalDeadline(500);
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
        const sandbox = await allocation.create(async () => f.sandbox as unknown as Sandbox);
        try {
          return await runModalCommand(
            sandbox,
            [],
            { ...request, outputPaths: [WRAPPER_STATUS_PATH] },
            { onLive: () => never() },
            deadline,
            new LiveSandboxRegistry(10),
          );
        } finally {
          await allocation.cleanup();
        }
      });
    } catch (error) {
      failure = error;
    } finally {
      deadline.dispose();
    }
    expect(failure).toBeInstanceOf(Error);
    const execution = (failure as Error).cause as SandboxExecutionError & {
      supervisionError: unknown;
      ownershipFailure: boolean;
    };
    expect(execution).toBeInstanceOf(SandboxExecutionError);
    expect(execution.cause).toBe(primary);
    expect(execution.supervisionError).toBeInstanceOf(SandboxSupervisionError);
    expect(execution.ownershipFailure).toBe(true);
    expect(execution.result.outputs[WRAPPER_STATUS_PATH]).toEqual(Buffer.from("0\n"));
    expect(logs).toEqual(["partial.log"]);
    expect(f.state().terminated).toBe(1);
  });
}

test("deadline before supervision finish is non-recoverable and retains the later ownership failure", async () => {
  const f = fixture();
  f.process.wait = () => never();
  const deadline = new ModalDeadline(10);
  let failure: unknown;
  try {
    await runModalCommand(
      f.sandbox as unknown as Sandbox,
      [],
      request,
      { onLive: () => never() },
      deadline,
      new LiveSandboxRegistry(20),
    );
  } catch (error) {
    failure = error;
  } finally {
    deadline.dispose();
  }
  expect(failure).toBeInstanceOf(SandboxExecutionError);
  const execution = failure as SandboxExecutionError & {
    supervisionError: unknown;
    ownershipFailure: boolean;
  };
  expect(execution.ownershipFailure).toBe(true);
  expect(execution.message).toContain("deadline");
  await Bun.sleep(40);
  expect(execution.supervisionError).toBeInstanceOf(SandboxSupervisionError);
});

test("ordinary command diagnostics remain recoverable after confirmed supervision success", async () => {
  const f = fixture();
  f.process.wait = async () => {
    throw new Error("transport diagnostic");
  };
  f.sandbox.filesystem.readBytes = async () => Buffer.from("0\n");
  const deadline = new ModalDeadline(500);
  const store = {
    put: async () => {
      throw new Error("unexpected failure log");
    },
  } as unknown as ArtifactStore;
  try {
    const result = await runSandboxWithFailureLog(store, "unused", () =>
      runModalCommand(
        f.sandbox as unknown as Sandbox,
        [],
        { ...request, outputPaths: [WRAPPER_STATUS_PATH] },
        { onLive: async () => {} },
        deadline,
        new LiveSandboxRegistry(10),
      ),
    );
    expect(result.exitCode).toBe(0);
  } finally {
    deadline.dispose();
  }
});
