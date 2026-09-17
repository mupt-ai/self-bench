import { describe, expect, test } from "bun:test";
import { NotFoundError } from "modal";
import { SandboxExecutionError } from "../../../../src/sandbox/contracts.js";
import { ModalCleanupError } from "../../../../src/sandbox/providers/modal/lifecycle.js";

import { deferred, failure, fixture, never, request } from "./fixture.js";

describe("Modal bounded lifecycle (offline SDK mocks)", () => {
  test("cancellation during create recovers by exact name and environment and terminates a late handle", async () => {
    const f = fixture();
    const controller = new AbortController();
    const created = deferred<typeof f.sandbox>();
    const started = deferred<void>();
    const original = f.client.sandboxes.create;
    f.client.sandboxes.create = async (...args) => {
      await original(...args);
      started.resolve();
      return created.promise;
    };
    const primary = new Error("cancelled create");
    const running = f.executor().run(request, { signal: controller.signal });
    await started.promise;
    controller.abort(primary);
    const error = await failure(running);
    expect(error).toBe(primary);
    expect(error.cleanupError).toBeInstanceOf(ModalCleanupError);
    expect(f.state().lookup).toEqual([
      "test-app",
      f.state().createName,
      { environment: "test-env" },
    ]);
    expect(f.state().executed).toBe(0);
    const late = { ...f.sandbox, sandboxId: "sb-late" };
    created.resolve(late);
    await Bun.sleep(5);
    expect(f.state().terminated).toBe(2);
  });

  test("late cleanup rejection remains observable after unresolved allocation is returned", async () => {
    const f = fixture();
    const created = deferred<typeof f.sandbox>();
    f.client.sandboxes.create = () => created.promise;
    f.client.sandboxes.fromName = async () => {
      throw new NotFoundError("not running yet");
    };
    const error = await failure(f.executor().run({ ...request, timeoutMs: 100 }));
    const rejected = new Error("late termination rejected");
    created.resolve({
      ...f.sandbox,
      terminate: async () => {
        throw rejected;
      },
    });
    await Bun.sleep(5);
    expect(error.cleanupError?.errors).toContain(rejected);
    expect(error.cleanupError?.message).toContain("may still exist");
  });

  test("ambiguous create rejection is recovered and still preserves the original failure", async () => {
    const f = fixture();
    const primary = new Error("transport lost create response");
    f.client.sandboxes.create = async () => {
      throw primary;
    };
    expect(await failure(f.executor().run(request))).toBe(primary);
    expect(f.state().terminated).toBe(1);
  });

  test("NotFound after ambiguous create does not claim absence", async () => {
    const f = fixture();
    const primary = new Error("transport lost create response");
    f.client.sandboxes.create = async () => {
      throw primary;
    };
    const lookup = new NotFoundError("not running");
    f.client.sandboxes.fromName = async () => {
      throw lookup;
    };
    const error = await failure(f.executor().run(request));
    expect(error).toBe(primary);
    expect(error.cleanupError?.errors).toContain(lookup);
    expect(error.cleanupError?.message).toContain("may still exist");
  });

  test("cancellation during upload settles and never launches command", async () => {
    const f = fixture();
    const controller = new AbortController();
    const primary = new Error("cancel upload");
    f.sandbox.filesystem.writeText = () => {
      controller.abort(primary);
      return never();
    };
    const error = await failure(
      f
        .executor()
        .run(
          { ...request, files: [{ path: "/work/in", contents: "x" }] },
          { signal: controller.signal },
        ),
    );
    expect(error).toBe(primary);
    expect(f.state()).toMatchObject({ terminated: 1, executed: 0 });
  });

  test("hung cleanup is bounded and fails an otherwise successful command", async () => {
    const f = fixture();
    f.sandbox.terminate = () => never();
    expect(await failure(f.executor().run(request))).toBeInstanceOf(ModalCleanupError);
  });

  test("cleanup rejection after success fails the run", async () => {
    const f = fixture();
    const rejection = new Error("termination rejected");
    f.sandbox.terminate = async () => {
      throw rejection;
    };
    const error = await failure(f.executor().run(request));
    expect(error).toBeInstanceOf(ModalCleanupError);
    expect((error as ModalCleanupError).errors).toContain(rejection);
  });

  test("cleanup failure preserves command failure, partial result and recovery guard marker", async () => {
    const f = fixture();
    const primary = new Error("command transport failed");
    f.process.wait = async () => {
      throw primary;
    };
    f.sandbox.terminate = async () => {
      throw new Error("cleanup failed");
    };
    const error = await failure(f.executor().run(request));
    expect(error).toBeInstanceOf(SandboxExecutionError);
    expect(error.cause).toBe(primary);
    expect("cleanupError" in error).toBe(true);
    expect((error as SandboxExecutionError).result.sandboxId).toBe("sb-owned");
  });

  test("missing requested output after exit zero fails with available diagnostics", async () => {
    const f = fixture();
    f.sandbox.filesystem.readBytes = async (path) => {
      if (path.endsWith("present")) return Buffer.from("diagnostics");
      throw new Error("missing");
    };
    const error = await failure(
      f
        .executor()
        .run({ ...request, timeoutMs: 6_000, outputPaths: ["/work/present", "/work/missing"] }),
    );
    expect(error).toBeInstanceOf(SandboxExecutionError);
    expect(error.message).toContain("Missing requested Modal output: /work/missing");
    expect((error as SandboxExecutionError).result.outputs["/work/present"]).toEqual(
      Buffer.from("diagnostics"),
    );
    expect(f.state().terminated).toBe(1);
  });

  test("termination rejection after cleanup timeout is retained", async () => {
    const f = fixture();
    const termination = deferred<number>();
    f.sandbox.terminate = () => termination.promise;
    const error = (await failure(f.executor().run(request))) as ModalCleanupError;
    const late = new Error("late termination rejection");
    termination.reject(late);
    await Bun.sleep(5);
    expect(error.errors).toContain(late);
  });

  test("diagnostic timeout does not replace the primary command failure", async () => {
    const f = fixture();
    const primary = new Error("process failed first");
    f.process.wait = async () => {
      throw primary;
    };
    f.sandbox.filesystem.readBytes = () => never();
    const error = await failure(f.executor().run({ ...request, outputPaths: ["/work/out"] }));
    expect(error.cause).toBe(primary);
    expect(f.state().terminated).toBe(1);
  });

  test("frozen primary errors remain the cause when cleanup also fails", async () => {
    const f = fixture();
    const primary = Object.freeze(new Error("staging failed"));
    f.sandbox.filesystem.writeText = async () => {
      throw primary;
    };
    f.sandbox.terminate = async () => {
      throw new Error("cleanup failed");
    };
    const error = await failure(
      f.executor().run({ ...request, files: [{ path: "/work/in", contents: "x" }] }),
    );
    expect(error.cause).toBe(primary);
    expect(error.cleanupError).toBeInstanceOf(ModalCleanupError);
  });

  test("recovery names retain full UUID entropy within Modal's 64-character limit", async () => {
    const f = fixture();
    await f.executor().run({ ...request, runId: "r".repeat(80), stage: "s".repeat(80) });
    expect(f.state().createName.length).toBeLessThanOrEqual(64);
    expect(f.state().createName).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  for (const stage of [
    "app",
    "create",
    "upload",
    "secret",
    "exec",
    "stdin",
    "wait",
    "stream",
    "output",
    "supervision",
  ] as const) {
    test(`local deadline bounds hung ${stage}`, async () => {
      const f = fixture();
      if (stage === "app") f.client.apps.fromName = () => never();
      if (stage === "create") f.client.sandboxes.create = () => never();
      if (stage === "upload") f.sandbox.filesystem.writeText = () => never();
      if (stage === "secret") f.client.secrets.fromObject = () => never();
      if (stage === "exec") f.sandbox.exec = () => never();
      if (stage === "stdin") f.process.closeStdin = () => never();
      if (stage === "wait") f.process.wait = () => never();
      if (stage === "stream") f.process.stdout = new ReadableStream<string>();
      if (stage === "output") f.sandbox.filesystem.readBytes = () => never();
      const error = await failure(
        f.executor().run(
          {
            ...request,
            timeoutMs: 100,
            files: [{ path: "/work/in", contents: "x" }],
            secrets: { TEST: "x" },
            outputPaths: ["/work/out"],
          },
          stage === "supervision" ? { onLive: () => never() } : {},
        ),
      );
      expect(error.message).toContain("deadline");
      if (stage !== "app") expect(f.state().terminated).toBe(1);
    }, 1_000);
  }
});
