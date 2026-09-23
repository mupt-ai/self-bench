import { describe, expect, test } from "bun:test";
import { SandboxExecutionError, type SandboxRequest } from "../../src/sandbox/contracts.js";
import { runSandbox, type SandboxSession, startSandbox } from "../../src/sandbox/session.js";

const request: SandboxRequest = {
  runId: "run",
  stage: "stage",
  command: ["run"],
  timeoutMs: 5_000,
  outputPaths: ["/work/out.txt"],
};

function fakeSession(exec: SandboxSession["exec"]) {
  const files = new Map<string, Uint8Array>();
  const events: string[] = [];
  const session: SandboxSession = {
    id: "fake",
    write: async (path, contents) => {
      files.set(path, contents);
    },
    read: async (path) => files.get(path),
    exec,
    spawn: async (command) => {
      events.push(`spawned ${command.join(" ")}`);
    },
    destroy: async () => {
      events.push("destroyed");
    },
  };
  return { session, files, events };
}

describe("startSandbox", () => {
  test("stages files, launches the command detached, and leaves the sandbox running", async () => {
    const fake = fakeSession(async () => 0);
    const started = await startSandbox(
      async () => fake.session,
      { ...request, files: [{ path: "/work/in.txt", contents: "input" }] },
      (sandbox) => ({ TOKEN: sandbox.sandboxId }),
    );
    expect(started).toEqual(expect.objectContaining({ sandboxId: "fake", stage: request.stage }));
    expect(Buffer.from(fake.files.get("/work/in.txt") ?? []).toString()).toBe("input");
    expect(fake.events).toEqual(["spawned run"]);
  });

  test("deletes the sandbox when the command cannot be launched", async () => {
    const fake = fakeSession(async () => 0);
    fake.session.spawn = async () => {
      throw new Error("spawn failed");
    };
    await expect(startSandbox(async () => fake.session, request)).rejects.toThrow("spawn failed");
    expect(fake.events).toEqual(["destroyed"]);
  });
});

describe("runSandbox", () => {
  test("stages files, streams output, collects outputs, and always deletes", async () => {
    const fake = fakeSession(async (_command, { onOutput, environment }) => {
      onOutput("stdout", Buffer.from(`hello ${environment.NAME}`));
      fake.files.set("/work/out.txt", Buffer.from(String(fake.files.get("/work/in.txt"))));
      return 0;
    });
    const result = await runSandbox(async () => fake.session, {
      ...request,
      files: [{ path: "/work/in.txt", contents: "input" }],
      environment: { NAME: "world" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
    expect(Buffer.from(result.outputs["/work/out.txt"] ?? []).toString()).toBe("input");
    expect(fake.events).toEqual(["destroyed"]);
  });

  test("a missing output after exit 0 fails; after a nonzero exit it is best-effort", async () => {
    const zero = fakeSession(async () => 0);
    await expect(runSandbox(async () => zero.session, request)).rejects.toThrow(
      "exited 0 without /work/out.txt",
    );
    expect(zero.events).toEqual(["destroyed"]);
    const failed = fakeSession(async () => 2);
    const result = await runSandbox(async () => failed.session, request);
    expect(result.exitCode).toBe(2);
    expect(result.outputs).toEqual({});
  }, 30_000);

  test("the deadline returns exit code 124", async () => {
    const fake = fakeSession(
      (_command, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
    const result = await runSandbox(async () => fake.session, {
      ...request,
      timeoutMs: 100,
      outputPaths: [],
    });
    expect(result.exitCode).toBe(124);
    expect(fake.events).toEqual(["destroyed"]);
  });

  test("the deadline covers allocation and never returns outputs", async () => {
    const late = fakeSession(async () => 0);
    const slow = await runSandbox(
      () => new Promise((resolve) => setTimeout(() => resolve(late.session), 300)),
      { ...request, timeoutMs: 100 },
    );
    expect(slow).toMatchObject({ exitCode: 124, sandboxId: "unallocated", outputs: {} });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(late.events).toEqual(["destroyed"]);
    const written = fakeSession(
      (_command, { signal }) =>
        new Promise((_resolve, reject) => {
          written.files.set("/work/out.txt", Buffer.from("partial"));
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const result = await runSandbox(async () => written.session, { ...request, timeoutMs: 100 });
    expect(result).toMatchObject({ exitCode: 124, outputs: {} });
  });

  test("a lost command is recovered only when every output was written", async () => {
    const finished = fakeSession(async () => {
      finished.files.set("/work/out.txt", Buffer.from("done"));
      throw new Error("stream terminated");
    });
    const recovered = await runSandbox(async () => finished.session, request);
    expect(recovered.exitCode).toBe(1);
    expect(recovered.stderr).toContain("stream terminated");
    const lost = fakeSession(async () => {
      throw new Error("stream terminated");
    });
    await expect(runSandbox(async () => lost.session, request)).rejects.toBeInstanceOf(
      SandboxExecutionError,
    );
  }, 30_000);
});
