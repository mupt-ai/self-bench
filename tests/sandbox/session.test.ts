import { describe, expect, test } from "bun:test";
import { SandboxExecutionError, type SandboxRequest } from "../../src/sandbox/contracts.js";
import { runSandbox, type SandboxSession } from "../../src/sandbox/session.js";

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
    destroy: async () => {
      events.push("destroyed");
    },
  };
  return { session, files, events };
}

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

  test("the live hook runs alongside the command and sees it exit", async () => {
    const fake = fakeSession(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      fake.files.set("/work/out.txt", Buffer.from("x"));
      return 0;
    });
    let sawExit = false;
    await runSandbox(async () => fake.session, request, {
      onLive: async (live, exited) => {
        await live.writeFile("/work/mailbox", "ping");
        await new Promise((resolve) => exited.addEventListener("abort", resolve, { once: true }));
        sawExit = true;
      },
    });
    expect(sawExit).toBe(true);
    expect(Buffer.from(fake.files.get("/work/mailbox") ?? []).toString()).toBe("ping");
  });
});
