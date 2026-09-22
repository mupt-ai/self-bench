import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { Context } from "@temporalio/activity";
import type { Session } from "@vercel/sandbox";
import type { ArtifactStore } from "../../../src/artifacts.js";
import { SessionVerifier } from "../../../src/generation/authoring/session-verify.js";
import * as processes from "../../../src/process.js";
import { RollingOutput } from "../../../src/process.js";
import { LiveSandboxRegistry } from "../../../src/sandbox/live.js";
import { DockerSandboxExecutor } from "../../../src/sandbox/providers/docker/executor.js";
import { executeVercelCommand } from "../../../src/sandbox/providers/vercel/command.js";
import { candidate, run } from "../../support/workflow-fixture.js";

afterEach(() => mock.restore());
function idleVerifier() {
  let polled!: () => void;
  const polling = new Promise<void>((resolve) => {
    polled = resolve;
  });
  spyOn(Context, "current").mockReturnValue({
    cancellationSignal: new AbortController().signal,
    heartbeat: () => polled(),
  } as unknown as Context);
  const verifier = new SessionVerifier({
    store: {} as ArtifactStore,
    harborEnvironment: "docker",
    run,
    candidate: candidate("idle", 1),
    stage: "authoring",
    round: 1,
    prefix: "unused",
  });
  return { verifier, polling };
}
const request = {
  runId: "idle",
  stage: "test",
  command: ["true"],
  timeoutMs: 1_000,
  outputPaths: ["/work/out"],
};
const ok = { exitCode: 0, stdout: "", stderr: "" };

test("real SessionVerifier resolves normal finish while sleeping after its first poll", async () => {
  const { verifier, polling } = idleVerifier();
  let polls = 0;
  const supervision = new LiveSandboxRegistry(50).start(
    "idle",
    {
      execute: async () => {
        polls++;
        return ok;
      },
      readFile: async () => undefined,
      writeFile: async () => {},
    },
    { onLive: (sandbox, signal) => verifier.supervise(sandbox, signal) },
  );
  await polling;
  await supervision.finish();
  expect(polls).toBe(1);
});

for (const operation of ["execute", "readFile"] as const)
  test(`idle ${operation} failure from a deleted sandbox is normal shutdown`, async () => {
    const { verifier } = idleVerifier();
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let rejectPoll!: (error: Error) => void;
    const pending = () =>
      new Promise<never>((_, reject) => {
        rejectPoll = reject;
        entered();
      });
    const supervision = new LiveSandboxRegistry(100).start(
      "idle-error",
      {
        execute: async () => (operation === "execute" ? pending() : ok),
        readFile: async () => pending(),
        writeFile: async () => {},
      },
      { onLive: (sandbox, signal) => verifier.supervise(sandbox, signal) },
    );
    await reading;
    const finishing = supervision.finish();
    rejectPoll(new Error("sandbox has been deleted"));
    await expect(finishing).resolves.toBeUndefined();
  });

test("expected idle read cancellation resolves without hiding an active handler failure", async () => {
  const { verifier } = idleVerifier();
  let reading!: () => void;
  const entered = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let exited!: AbortSignal;
  const supervision = new LiveSandboxRegistry(50).start(
    "read-race",
    {
      execute: async () => ok,
      readFile: async () =>
        new Promise((_, reject) => {
          exited.addEventListener("abort", () => reject(exited.reason), { once: true });
          reading();
        }),
      writeFile: async () => {},
    },
    {
      onLive: (sandbox, signal) => {
        exited = signal;
        return verifier.supervise(sandbox, signal);
      },
    },
  );
  await entered;
  await supervision.finish();
});

test("Docker collects successful outputs after idle SessionVerifier shutdown (mocked CLI only)", async () => {
  const { verifier, polling } = idleVerifier();
  let outputRead = false;
  spyOn(processes, "runCommand").mockImplementation(async (command, args) => {
    expect(command).toBe("docker");
    if (args[0] === "start") await polling;
    if (args[0] === "cp" && args[1]?.endsWith(":/work/mailbox/done")) return { ...ok, exitCode: 1 };
    if (args[0] === "cp" && args[1]?.endsWith(":/work/out")) {
      const destination = args[2];
      if (!destination) throw new Error("missing copy destination");
      await writeFile(destination, "kept output");
      outputRead = true;
    }
    return ok;
  });
  const result = await new DockerSandboxExecutor({ kind: "docker", image: "offline" }).run(
    request,
    {
      onLive: (sandbox, signal) => verifier.supervise(sandbox, signal),
    },
  );
  expect(result.exitCode).toBe(0);
  expect(outputRead).toBe(true);
  expect(Buffer.from(result.outputs["/work/out"] ?? []).toString()).toBe("kept output");
});

test("Vercel collects successful outputs after idle SessionVerifier shutdown (mocked SDK only)", async () => {
  const { verifier, polling } = idleVerifier();
  const session = {
    runCommand: async () => ({
      async *logs() {
        await polling;
        yield { stream: "stdout", data: "" };
      },
      wait: async () => ({ exitCode: 0 }),
    }),
    readFileToBuffer: async () => Buffer.from("kept output"),
  } as unknown as Session;
  const registry = new LiveSandboxRegistry(50);
  const result = await executeVercelCommand({
    session,
    request,
    options: {},
    signal: new AbortController().signal,
    stdout: new RollingOutput(),
    stderr: new RollingOutput(),
    terminate: (error) => {
      throw error;
    },
    startSupervision: () =>
      registry.start(
        "vercel-idle",
        {
          execute: async () => ok,
          readFile: async () => undefined,
          writeFile: async () => {},
        },
        { onLive: (sandbox, signal) => verifier.supervise(sandbox, signal) },
      ),
  });
  expect(result.exitCode).toBe(0);
  expect(Buffer.from(result.outputs["/work/out"] ?? []).toString()).toBe("kept output");
});
