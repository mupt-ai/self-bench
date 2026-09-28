import { describe, expect, test } from "bun:test";
import { SandboxExecutionError, type SandboxRequest } from "../../src/sandbox/contracts.js";
import { fileUploadScript } from "../../src/sandbox/remote-files.js";
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

  test("does not allocate when cancellation is already requested", async () => {
    let opened = 0;
    const controller = new AbortController();
    controller.abort(new Error("cancelled before run"));
    await expect(
      runSandbox(
        async () => {
          opened++;
          return fakeSession(async () => 0).session;
        },
        request,
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled before run");
    expect(opened).toBe(0);
  });

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

  describe("uploads", () => {
    const digest = "a".repeat(64);
    // The run writes out.txt; the sandbox answers digest and upload commands like bash would.
    const uploadingSession = (runExit = 0) => {
      const commands: string[] = [];
      const reads: string[] = [];
      const fake = fakeSession(async (command, { onOutput }) => {
        const script = command.join(" ");
        commands.push(script);
        if (script.includes("sha256sum")) {
          if (!fake.files.has("/work/out.txt")) return 1;
          onOutput("stdout", Buffer.from(`${digest} 7`));
          return 0;
        }
        if (script.includes("curl")) return 0;
        fake.files.set("/work/out.txt", Buffer.from("archive"));
        return runExit;
      });
      const read = fake.session.read;
      fake.session.read = async (path, signal) => {
        reads.push(path);
        return read(path, signal);
      };
      return { ...fake, commands, reads };
    };

    test("the sandbox PUTs a declared upload itself and it is never read back", async () => {
      const fake = uploadingSession();
      const targets: unknown[] = [];
      const result = await runSandbox(async () => fake.session, request, {
        uploads: {
          "/work/out.txt": async (file) => {
            targets.push(file);
            return { url: "https://storage.example/put?sig=1", headers: { "x-meta": "v" } };
          },
        },
      });
      expect(targets).toEqual([{ sha256: digest, sizeBytes: 7 }]);
      expect(result).toMatchObject({
        exitCode: 0,
        outputs: {},
        uploaded: { "/work/out.txt": { sha256: digest, sizeBytes: 7 } },
      });
      expect(fake.reads).toEqual([]);
      const upload = fake.commands.find((command) => command.includes("curl"));
      expect(upload).toContain("'https://storage.example/put?sig=1'");
      expect(upload).toContain("-H 'x-meta: v'");
    });

    test("a failed run never reads an upload back", async () => {
      const fake = uploadingSession(2);
      const result = await runSandbox(async () => fake.session, request, {
        uploads: { "/work/out.txt": async () => ({ url: "https://storage.example", headers: {} }) },
      });
      expect(result).toMatchObject({ exitCode: 2, outputs: {} });
      expect(fake.reads).toEqual([]);
      expect(fake.commands.some((command) => command.includes("curl"))).toBe(false);
    });

    test("a store without upload URLs gets the output read back", async () => {
      const fake = uploadingSession();
      const result = await runSandbox(async () => fake.session, request, {
        uploads: { "/work/out.txt": async () => undefined },
      });
      expect(Buffer.from(result.outputs["/work/out.txt"] ?? []).toString()).toBe("archive");
      expect(result.uploaded).toBeUndefined();
    });

    test("a failed upload fails the run", async () => {
      const fake = uploadingSession();
      const exec = fake.session.exec;
      fake.session.exec = async (command, options) =>
        command.join(" ").includes("curl") ? 22 : exec(command, options);
      await expect(
        runSandbox(async () => fake.session, request, {
          uploads: {
            "/work/out.txt": async () => ({ url: "https://storage.example", headers: {} }),
          },
        }),
      ).rejects.toThrow("could not upload /work/out.txt");
      expect(fake.events).toEqual(["destroyed"]);
    });
  });

  test("the upload script accepts an object an earlier try created and fails other errors", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new Response(null, { status: Number(new URL(request.url).pathname.slice(1)) }),
    });
    const exit = async (status: number) =>
      await Bun.spawn(
        [
          "bash",
          "-c",
          fileUploadScript(import.meta.path, { url: `${server.url}${status}`, headers: {} }),
        ],
        { stderr: "ignore" },
      ).exited;
    try {
      expect(await exit(200)).toBe(0);
      expect(await exit(412)).toBe(0);
      expect(await exit(403)).not.toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
