import { describe, expect, test } from "bun:test";
import type { LiveSandbox } from "../../src/sandbox/contracts.js";
import { LiveSandboxRegistry } from "../../src/sandbox/live.js";

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
