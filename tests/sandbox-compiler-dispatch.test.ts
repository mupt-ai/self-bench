import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { SandboxExecutor, SandboxRequest } from "../src/sandbox/contracts.js";
import { taskSandbox, withTaskSandbox } from "../src/sandbox/task-context.js";
import * as runtime from "../src/temporal/activities/runtime.js";
import {
  compileSubmittedTask,
  TaskCompilerInfrastructureError,
} from "../src/temporal/activities/task-compiler.js";

beforeEach(() => {
  spyOn(runtime, "readAsset").mockResolvedValue(Buffer.from("trusted compiler fixture"));
});
afterEach(() => mock.restore());

const input = {
  taskId: "task",
  repositoryUrl: "https://github.com/example/repo",
  definitionBytes: Buffer.from("{}"),
  sourceBundle: Buffer.from("submission"),
  token: "private-token",
};
function executor(run: SandboxExecutor["run"]): SandboxExecutor {
  return {
    run,
    execute: async () => {
      throw Error("unused");
    },
    readFile: async () => {
      throw Error("unused");
    },
    writeFile: async () => {
      throw Error("unused");
    },
    close: () => {},
  };
}
test("worker dispatches trusted compiler with scoped token and no local Git process", async () => {
  let request: SandboxRequest | undefined;
  const signal = new AbortController().signal;
  const sandbox = executor(async (value, options) => {
    request = value;
    expect(options?.signal).toBe(signal);
    return {
      sandboxId: "fresh",
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputs: {
        "/work/result.json": Buffer.from('{"ok":true}'),
        "/work/compiled.tar.gz": Buffer.from("compiled"),
      },
    };
  });
  expect(Buffer.from(await compileSubmittedTask({ ...input, signal }, sandbox)).toString()).toBe(
    "compiled",
  );
  expect(request?.command).toEqual(["node", "/work/compiler.js"]);
  expect(request?.secrets).toEqual({ GH_TOKEN: "private-token" });
  expect(JSON.stringify(request?.files)).not.toContain("private-token");
  expect(request?.files?.some((file) => file.path === "/work/runtime/junit.py")).toBe(true);
  const workerSource = await Bun.file(
    new URL("../src/temporal/activities/task-compiler.ts", import.meta.url),
  ).text();
  expect(workerSource).not.toMatch(
    /runCommand|cloneRepository|compileHarborTask|extractRegularArchive/,
  );
});
test("sandbox compilation errors fail closed and retain infrastructure classification", async () => {
  for (const infrastructure of [true, false]) {
    const sandbox = executor(async () => ({
      sandboxId: "fresh",
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputs: {
        "/work/result.json": Buffer.from(
          JSON.stringify({ ok: false, infrastructure, message: "rejected" }),
        ),
        "/work/compiled.tar.gz": Buffer.alloc(0),
      },
    }));
    const error = await compileSubmittedTask(input, sandbox).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof TaskCompilerInfrastructureError).toBe(infrastructure);
  }
});
test("compiler requires sandbox context and concurrent accounts cannot cross", async () => {
  expect(() => taskSandbox()).toThrow("requires");
  const a = executor(async () => {
      throw Error("a");
    }),
    b = executor(async () => {
      throw Error("b");
    });
  await Promise.all([
    withTaskSandbox(a, async () => {
      await Bun.sleep(5);
      expect(taskSandbox()).toBe(a);
    }),
    withTaskSandbox(b, async () => {
      expect(taskSandbox()).toBe(b);
    }),
  ]);
  expect(() => taskSandbox()).toThrow();
});
