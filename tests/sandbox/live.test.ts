import { describe, expect, test } from "bun:test";
import type { LiveSandbox } from "../../src/sandbox/contracts.js";
import { LiveSandboxRegistry, SandboxSupervisionError } from "../../src/sandbox/live.js";

function backing(files: Map<string, Uint8Array>) {
  return {
    execute: async (command: readonly string[]) => ({
      exitCode: 0,
      stdout: command.join(" "),
      stderr: "",
    }),
    readFile: async (path: string) => files.get(path),
    writeFile: async (path: string, contents: Uint8Array | string) => {
      files.set(path, typeof contents === "string" ? Buffer.from(contents) : contents);
    },
  };
}

describe("LiveSandboxRegistry", () => {
  test("serves execute, readFile, and writeFile while the command runs and rejects afterwards", async () => {
    const registry = new LiveSandboxRegistry();
    const files = new Map<string, Uint8Array>();
    let observed: LiveSandbox | undefined;
    let exitedDuringHook = false;
    let hookFinished = false;
    const supervision = registry.start("sb-1", backing(files), {
      onLive: async (live, exited) => {
        observed = live;
        await live.writeFile("/work/mailbox/responses/1.json", "{}");
        await new Promise<void>((resolve) => exited.addEventListener("abort", () => resolve()));
        exitedDuringHook = exited.aborted;
        hookFinished = true;
      },
    });

    expect((await registry.execute("sb-1", ["ls", "/work"])).stdout).toBe("ls /work");
    await registry.writeFile("sb-1", "/work/a.txt", "hello");
    expect(Buffer.from((await registry.readFile("sb-1", "/work/a.txt")) ?? []).toString()).toBe(
      "hello",
    );
    expect(() => registry.readFile("sb-1", "/etc/passwd")).toThrow("must be beneath /work");
    expect(hookFinished).toBe(false);

    await supervision.finish();

    expect(observed?.sandboxId).toBe("sb-1");
    expect(exitedDuringHook).toBe(true);
    expect(hookFinished).toBe(true);
    expect(files.has("/work/mailbox/responses/1.json")).toBe(true);
    expect(() => registry.execute("sb-1", ["true"])).toThrow("sandbox sb-1 is not running");
  });

  test("propagates an onLive failure from finish and still unregisters", async () => {
    const registry = new LiveSandboxRegistry();
    const supervision = registry.start("sb-2", backing(new Map()), {
      onLive: async () => {
        throw new Error("supervisor crashed");
      },
    });

    await expect(supervision.finish()).rejects.toThrow("supervisor crashed");
    expect(() => registry.execute("sb-2", ["true"])).toThrow("not running");
  });

  test("finishes immediately without an onLive hook", async () => {
    const registry = new LiveSandboxRegistry();
    await registry.start("sb-3", backing(new Map()), {}).finish();
  });
});

test("callback handles use the same validation and lifetime as registry operations", async () => {
  const registry = new LiveSandboxRegistry();
  let captured: LiveSandbox | undefined;
  const supervision = registry.start("guarded", backing(new Map()), {
    onLive: async (live) => {
      captured = live;
      expect(() => live.readFile("/etc/passwd")).toThrow("must be beneath /work");
      expect(() => live.writeFile("/work/../outside", "x")).toThrow();
      expect(() => live.execute([])).toThrow("must not be empty");
    },
  });
  await supervision.finish();
  expect(captured).toBeDefined();
  expect(() => captured?.readFile("/work/file")).toThrow("not running");
  expect(() => captured?.writeFile("/work/file", "x")).toThrow("not running");
  expect(() => captured?.execute(["true"])).toThrow("not running");
});

test("a stuck hook cannot prevent disposal and stale handles cannot target a reused ID", async () => {
  const registry = new LiveSandboxRegistry(10);
  let captured: LiveSandbox | undefined;
  const first = registry.start("reused", backing(new Map()), {
    onLive: async (live) => {
      captured = live;
      await new Promise(() => {});
    },
  });
  await expect(first.finish()).rejects.toThrow("supervision did not settle");
  const second = registry.start("reused", backing(new Map()), {});
  expect(() => captured?.execute(["true"])).toThrow("not running");
  await second.finish();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("finish caches the same promise before abort listeners can reenter it", async () => {
  const registry = new LiveSandboxRegistry(100);
  const entered = deferred<void>();
  const released = deferred<void>();
  let reentrant: Promise<void> | undefined;
  let aborts = 0;
  const handle = registry.start("reentrant", backing(new Map()), {
    onLive: async (_live, exited) => {
      exited.addEventListener("abort", () => {
        aborts++;
        reentrant = handle.finish();
      });
      entered.resolve();
      await released.promise;
    },
  });
  await entered.promise;
  expect(handle.settlement()).toEqual({ status: "pending" });
  const first = handle.finish();
  expect(handle.finish()).toBe(first);
  expect(reentrant).toBe(first);
  expect(aborts).toBe(1);
  released.resolve();
  await first;
  expect(handle.settlement()).toEqual({ status: "succeeded" });
  expect(handle.finish()).toBe(first);
  expect(aborts).toBe(1);
});

test("repeated finish calls share one grace and cannot dispose a reused ID", async () => {
  const registry = new LiveSandboxRegistry(20);
  const first = registry.start("one-grace", backing(new Map()), {
    onLive: () => new Promise(() => {}),
  });
  const finishing = first.finish();
  await Bun.sleep(5);
  expect(first.finish()).toBe(finishing);
  let failure: unknown;
  try {
    await finishing;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SandboxSupervisionError);
  expect(first.settlement()).toEqual({ status: "failed", error: failure });
  const second = registry.start("one-grace", backing(new Map()), {});
  // A settled repeated call must neither restart the grace nor unregister the new entry.
  expect(first.finish()).toBe(finishing);
  await expect(first.finish()).rejects.toBe(failure);
  expect((await registry.execute("one-grace", ["true"])).exitCode).toBe(0);
  await second.finish();
});

test("late hook rejection retains timeout evidence without reviving stale handles", async () => {
  const registry = new LiveSandboxRegistry(10);
  const released = deferred<void>();
  let captured: LiveSandbox | undefined;
  const first = registry.start("late", backing(new Map()), {
    onLive: async (live) => {
      captured = live;
      await released.promise;
    },
  });
  let timeout: unknown;
  try {
    await first.finish();
  } catch (error) {
    timeout = error;
  }
  expect(timeout).toBeInstanceOf(SandboxSupervisionError);
  const second = registry.start("late", backing(new Map()), {});
  const late = new Error("late hook failure");
  released.reject(late);
  await Bun.sleep(1);
  expect(first.settlement()).toEqual({ status: "failed", error: timeout, lateError: late });
  await expect(first.finish()).rejects.toBe(timeout);
  expect(() => captured?.readFile("/work/file")).toThrow("not running");
  expect(() => captured?.writeFile("/work/file", "late")).toThrow("not running");
  expect((await registry.execute("late", ["true"])).exitCode).toBe(0);
  await second.finish();
});

test("hook failure before finish remains a cached typed rejection", async () => {
  const rejection = new Error("hook rejected");
  const handle = new LiveSandboxRegistry(50).start("rejected", backing(new Map()), {
    onLive: async () => {
      throw rejection;
    },
  });
  await Bun.sleep(1);
  const first = handle.finish();
  await expect(first).rejects.toBe(rejection);
  expect(handle.settlement()).toEqual({ status: "failed", error: rejection });
  expect(handle.finish()).toBe(first);
});
