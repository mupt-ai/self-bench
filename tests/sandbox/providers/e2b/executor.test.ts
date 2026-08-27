import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  type CommandHandle,
  type SandboxInfo,
  SandboxNotFoundError,
} from "e2b";
import { InactivityTimeoutError } from "../../../../src/process.js";
import { SandboxExecutionError } from "../../../../src/sandbox/contracts.js";
import {
  type E2BSandboxApi,
  E2BSandboxExecutor,
  type E2BSandboxHandle,
} from "../../../../src/sandbox/providers/e2b/executor.js";

const config = {
  kind: "e2b" as const,
  image: "selfbench-runtime:v1",
  timeoutCapMs: 60 * 60 * 1_000,
  credentials: { apiKey: "e2b_test_key", domain: "custom.e2b.example" },
};

const fastLifecycleTimings = {
  cleanupCallTimeoutMs: 20,
  cleanupRecoveryDelaysMs: [0, 1],
  cleanupTimeoutMs: 100,
  commandKillGraceMs: 5,
  diagnosticTimeoutMs: 20,
};

class E2BSdkFixture {
  readonly api: E2BSandboxApi;
  readonly calls: string[] = [];
  readonly outputs = new Map<string, Uint8Array>();
  readonly uploadedFiles = new Map<string, Uint8Array>();
  command = "";
  commandOptions: Record<string, unknown> = {};
  cpuCount = 4;
  memoryMB = 8192;
  exitCode = 7;
  stdout = ["hello ", "world\n"];
  stderr = ["warning\n"];
  streamOutput = true;
  waitError: unknown;
  commandRunError: unknown;
  holdCommand = false;
  holdCommandStart = false;
  ignoreCommandAbort = false;
  commandKillHangs = false;
  commandKillReleases = true;
  holdCreate = false;
  ignoreCreateAbort = false;
  holdReads = false;
  createError: unknown;
  allocationExists = false;
  instanceKillError: unknown;
  instanceKillHangs = false;
  instanceKillResult = true;
  instanceKillRemovesAllocation = true;
  staticKillError: unknown;
  staticKillHangs = false;
  staticKillResult = true;
  staticGetInfoError: unknown;
  listMatchesAllocation = false;
  listState: "running" | "paused" = "running";
  listOptions: Record<string, unknown> = {};
  createOptions: Record<string, unknown> = {};
  #releaseCommand: ((value: never) => void) | undefined;
  #releaseCreate: (() => void) | undefined;

  constructor() {
    const sandbox: E2BSandboxHandle = {
      sandboxId: "sb-e2b-test",
      commands: {
        run: async (command: string, options: Record<string, unknown>) => {
          this.calls.push("command.run");
          this.command = command;
          this.commandOptions = options;
          if (this.commandRunError) {
            throw this.commandRunError;
          }
          const onStdout = options.onStdout as ((data: string) => void | Promise<void>) | undefined;
          const onStderr = options.onStderr as ((data: string) => void | Promise<void>) | undefined;
          if (this.streamOutput) {
            for (const chunk of this.stdout) {
              await onStdout?.(chunk);
            }
            for (const chunk of this.stderr) {
              await onStderr?.(chunk);
            }
          }
          const signal = options.signal as AbortSignal | undefined;
          if (this.holdCommandStart) {
            return await new Promise<never>(() => {});
          }
          signal?.throwIfAborted();
          const wait = async () => {
            if (this.holdCommand) {
              return await new Promise<never>((_resolve, reject) => {
                this.#releaseCommand = reject;
                if (!this.ignoreCommandAbort) {
                  signal?.addEventListener(
                    "abort",
                    () => reject(signal.reason ?? new Error("aborted")),
                    { once: true },
                  );
                }
              });
            }
            if (this.waitError) {
              throw this.waitError;
            }
            if (this.exitCode !== 0) {
              throw Object.assign(new Error(`command exited ${this.exitCode}`), {
                exitCode: this.exitCode,
                stdout: this.stdout.join(""),
                stderr: this.stderr.join(""),
              });
            }
            return {
              exitCode: this.exitCode,
              stdout: this.stdout.join(""),
              stderr: this.stderr.join(""),
            };
          };
          return {
            pid: 42,
            wait,
            kill: async () => {
              this.calls.push("command.kill");
              if (this.commandKillReleases) {
                this.#releaseCommand?.(new Error("command killed") as never);
              }
              if (this.commandKillHangs) {
                return await new Promise<never>(() => {});
              }
              return true;
            },
          } as unknown as CommandHandle;
        },
      } as E2BSandboxHandle["commands"],
      files: {
        writeFiles: async (
          files: Array<{ path: string; data: string | ArrayBuffer }>,
          _options?: unknown,
        ) => {
          this.calls.push("files.writeFiles");
          for (const file of files) {
            this.uploadedFiles.set(
              file.path,
              typeof file.data === "string" ? Buffer.from(file.data) : new Uint8Array(file.data),
            );
          }
          return [];
        },
        read: async (path: string) => {
          this.calls.push(`files.read:${path}`);
          if (this.holdReads) {
            return await new Promise<never>(() => {});
          }
          const value = this.outputs.get(path);
          if (!value) {
            throw new Error(`missing ${path}`);
          }
          return value;
        },
      } as unknown as E2BSandboxHandle["files"],
      getInfo: async () => {
        this.calls.push("sandbox.getInfo");
        return {
          sandboxId: "sb-e2b-test",
          state: "running",
          cpuCount: this.cpuCount,
          memoryMB: this.memoryMB,
          metadata: { ...(this.createOptions.metadata as Record<string, string>) },
          lifecycle: { onTimeout: "kill", autoResume: false },
        } as SandboxInfo;
      },
      kill: async () => {
        this.calls.push("sandbox.kill");
        if (this.instanceKillHangs) {
          return await new Promise<never>(() => {});
        }
        if (this.instanceKillError) {
          throw this.instanceKillError;
        }
        if (this.instanceKillResult && this.instanceKillRemovesAllocation) {
          this.allocationExists = false;
        }
        return this.instanceKillResult;
      },
    };

    this.api = {
      create: async (_template, options) => {
        this.calls.push("sandbox.create");
        this.createOptions = options as Record<string, unknown>;
        this.allocationExists = true;
        if (this.holdCreate) {
          const signal = options?.signal;
          return await new Promise<E2BSandboxHandle>((resolve, reject) => {
            this.#releaseCreate = () => resolve(sandbox);
            if (!this.ignoreCreateAbort) {
              signal?.addEventListener(
                "abort",
                () => reject(signal.reason ?? new Error("aborted")),
                { once: true },
              );
            }
          });
        }
        if (this.createError) {
          throw this.createError;
        }
        return sandbox;
      },
      getInfo: async (sandboxId) => {
        this.calls.push(`Sandbox.getInfo:${sandboxId}`);
        if (this.staticGetInfoError) {
          throw this.staticGetInfoError;
        }
        if (!this.allocationExists) {
          throw new SandboxNotFoundError(`Sandbox ${sandboxId} not found`);
        }
        return { sandboxId } as SandboxInfo;
      },
      kill: async (sandboxId) => {
        this.calls.push(`Sandbox.kill:${sandboxId}`);
        if (this.staticKillHangs) {
          return await new Promise<never>(() => {});
        }
        if (this.staticKillError) {
          throw this.staticKillError;
        }
        if (this.staticKillResult) {
          this.allocationExists = false;
        }
        return this.staticKillResult;
      },
      list: (options) => {
        this.calls.push("Sandbox.list");
        this.listOptions = (options ?? {}) as Record<string, unknown>;
        let hasNext = true;
        return {
          get hasNext() {
            return hasNext;
          },
          nextItems: async () => {
            this.calls.push("Sandbox.list.nextItems");
            hasNext = false;
            return this.listMatchesAllocation && this.allocationExists
              ? ([{ sandboxId: "sb-late-e2b", state: this.listState }] as SandboxInfo[])
              : [];
          },
        };
      },
    };
  }

  releaseCreate(): void {
    this.#releaseCreate?.();
  }
}

describe("E2BSandboxExecutor", () => {
  test("runs with isolated creation, exact inputs, streaming, outputs, and cleanup", async () => {
    const fixture = new E2BSdkFixture();
    fixture.outputs.set("/work/result.bin", Uint8Array.from([0, 255, 1]));
    fixture.outputs.set("/work/empty.bin", new Uint8Array());
    const executor = new E2BSandboxExecutor(config, fixture.api);
    const progress: Array<{ stream: "stdout" | "stderr"; bytes: number }> = [];
    const backing = Uint8Array.from([9, 0, 1, 2, 8]);

    const result = await executor.run(
      {
        runId: "run-e2b",
        stage: "author",
        command: ["node", "script.js", "space value", "quote'value", ""],
        files: [
          { path: "/work/input.bin", contents: backing.subarray(1, 4) },
          { path: "/work/unicode.txt", contents: "héllo 🌍" },
        ],
        outputPaths: ["/work/result.bin", "/work/empty.bin", "/work/missing-after-nonzero"],
        environment: {
          SHARED: "ordinary",
          EMPTY: "",
          E2B_DOMAIN: "do-not-leak",
          E2B_FUTURE_CONTROL: "do-not-leak-either",
        },
        secrets: {
          SHARED: "secret",
          API_KEY: "workload-only",
          E2B_API_KEY: "do-not-leak",
        },
        timeoutMs: 60_000,
        inactivityTimeoutMs: 10_000,
        cpu: 4,
        memoryMiB: 8192,
      },
      { onProgress: (event) => progress.push(event) },
    );

    expect(result).toEqual({
      sandboxId: "sb-e2b-test",
      exitCode: 7,
      stdout: "hello world\n",
      stderr: "warning\n",
      outputs: {
        "/work/result.bin": Uint8Array.from([0, 255, 1]),
        "/work/empty.bin": new Uint8Array(),
      },
    });
    expect(progress).toEqual([
      { stream: "stdout", bytes: 6 },
      { stream: "stdout", bytes: 6 },
      { stream: "stderr", bytes: 8 },
    ]);
    expect(fixture.uploadedFiles.get("/work/input.bin")).toEqual(Uint8Array.from([0, 1, 2]));
    expect(Buffer.from(fixture.uploadedFiles.get("/work/unicode.txt") ?? []).toString()).toBe(
      "héllo 🌍",
    );
    expect(fixture.command).toBe("'node' 'script.js' 'space value' 'quote'\"'\"'value' ''");
    expect(fixture.commandOptions).toMatchObject({
      background: true,
      cwd: "/work",
      timeoutMs: 60_000,
      envs: { SHARED: "secret", EMPTY: "", API_KEY: "workload-only" },
    });
    expect(JSON.stringify(fixture.commandOptions)).not.toContain("e2b_test_key");
    expect(fixture.createOptions).toMatchObject({
      lifecycle: { onTimeout: "kill" },
      timeoutMs: 60_000,
      metadata: {
        selfbench_run: "run-e2b",
        selfbench_stage: "author",
        selfbench_allocation: expect.any(String),
      },
    });
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
    expect(fixture.allocationExists).toBe(false);
  });

  test("rejects invalid paths and resource values before allocation", async () => {
    const fixture = new E2BSdkFixture();
    const executor = new E2BSandboxExecutor(config, fixture.api);

    await expect(
      executor.run({
        runId: "invalid",
        stage: "path",
        command: ["true"],
        files: [{ path: "/work/../secret", contents: "no" }],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("sandbox path must be beneath /work");
    await expect(
      executor.run({
        runId: "invalid",
        stage: "cpu",
        command: ["true"],
        timeoutMs: 1_000,
        cpu: 0,
      }),
    ).rejects.toThrow("CPU must be a positive integer");
    expect(fixture.calls).toEqual([]);
  });

  test("validates template resources after allocation and always cleans up", async () => {
    const fixture = new E2BSdkFixture();
    fixture.memoryMB = 4096;
    const executor = new E2BSandboxExecutor(config, fixture.api);

    await expect(
      executor.run({ runId: "resource", stage: "author", command: ["true"], timeoutMs: 1_000 }),
    ).rejects.toThrow("allocated 4 CPU/4096 MiB");
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });

  test("preserves partial logs and outputs when remote execution fails", async () => {
    const fixture = new E2BSdkFixture();
    fixture.waitError = new Error("transport failed");
    fixture.outputs.set("/work/partial.json", Buffer.from('{"status":"partial"}'));
    const executor = new E2BSandboxExecutor(config, fixture.api);

    try {
      await executor.run({
        runId: "failure",
        stage: "review",
        command: ["false"],
        outputPaths: ["/work/partial.json"],
        timeoutMs: 1_000,
      });
      throw new Error("expected execution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxExecutionError);
      expect(error).toMatchObject({
        result: {
          sandboxId: "sb-e2b-test",
          exitCode: 1,
          stdout: "hello world\n",
          stderr: "warning\n",
          outputs: { "/work/partial.json": Buffer.from('{"status":"partial"}') },
        },
      });
      expect(String(error)).toContain("transport failed");
    }
    expect(fixture.calls.indexOf("command.kill")).toBeLessThan(
      fixture.calls.indexOf("files.read:/work/partial.json"),
    );
    expect(fixture.calls.indexOf("files.read:/work/partial.json")).toBeLessThan(
      fixture.calls.indexOf("sandbox.kill"),
    );
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });

  test("retains buffered command output when stream callbacks deliver nothing", async () => {
    const fixture = new E2BSdkFixture();
    fixture.streamOutput = false;
    fixture.exitCode = 0;

    const result = await new E2BSandboxExecutor(config, fixture.api).run({
      runId: "buffered-output",
      stage: "author",
      command: ["true"],
      timeoutMs: 1_000,
    });

    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("warning\n");
  });

  test("preserves partial outputs when command start fails", async () => {
    const fixture = new E2BSdkFixture();
    fixture.commandRunError = new Error("command start failed");
    fixture.outputs.set("/work/partial.json", Buffer.from("partial"));

    try {
      await new E2BSandboxExecutor(config, fixture.api).run({
        runId: "start-failure",
        stage: "review",
        command: ["false"],
        outputPaths: ["/work/partial.json"],
        timeoutMs: 1_000,
      });
      throw new Error("expected execution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxExecutionError);
      expect((error as SandboxExecutionError).result.outputs["/work/partial.json"]).toEqual(
        Buffer.from("partial"),
      );
      expect(String(error)).toContain("command start failed");
    }
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });

  test("does not allocate when cancellation is already requested", async () => {
    const fixture = new E2BSdkFixture();
    const executor = new E2BSandboxExecutor(config, fixture.api);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before run"));

    await expect(
      executor.run(
        { runId: "cancelled", stage: "author", command: ["true"], timeoutMs: 1_000 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled before run");
    expect(fixture.calls).toEqual([]);
  });

  test("settles cancellation during create even when create ignores abort", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCreate = true;
    fixture.ignoreCreateAbort = true;
    fixture.listMatchesAllocation = true;
    fixture.listState = "paused";
    const executor = new E2BSandboxExecutor(
      config,
      fixture.api,
      async (_delayMs, signal) => signal.throwIfAborted(),
      fastLifecycleTimings,
    );
    const controller = new AbortController();

    const failure = executor.run(
      { runId: "cancel-create", stage: "author", command: ["true"], timeoutMs: 1_000 },
      { signal: controller.signal },
    );
    await Bun.sleep(0);
    controller.abort(new Error("cancelled while creating"));

    await expect(failure).rejects.toThrow("cancelled while creating");
    expect(fixture.calls).toContain("Sandbox.kill:sb-late-e2b");
    expect(fixture.listOptions).not.toHaveProperty("state");
    expect(fixture.allocationExists).toBe(false);
  });

  test("cleans up a create handle that arrives after local cancellation", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCreate = true;
    fixture.ignoreCreateAbort = true;
    const controller = new AbortController();
    const executor = new E2BSandboxExecutor(
      config,
      fixture.api,
      async (delayMs, signal) => {
        signal.throwIfAborted();
        if (delayMs > 0) {
          fixture.releaseCreate();
          await Bun.sleep(0);
        }
      },
      fastLifecycleTimings,
    );

    const failure = executor.run(
      { runId: "late-create", stage: "author", command: ["true"], timeoutMs: 1_000 },
      { signal: controller.signal },
    );
    await Bun.sleep(0);
    controller.abort(new Error("cancel before create response"));

    await expect(failure).rejects.toThrow("cancel before create response");
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.allocationExists).toBe(false);
  });

  test("cancels a running command and kills the whole sandbox", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommand = true;
    const executor = new E2BSandboxExecutor(config, fixture.api);
    const controller = new AbortController();

    const failure = executor.run(
      { runId: "cancel", stage: "author", command: ["true"], timeoutMs: 1_000 },
      {
        signal: controller.signal,
        onProgress: () => controller.abort(new Error("cancelled from progress")),
      },
    );

    await expect(failure).rejects.toThrow("cancelled from progress");
    expect(fixture.calls).toContain("sandbox.kill");
  });

  test("reports output inactivity with partial diagnostics", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommand = true;
    const executor = new E2BSandboxExecutor(config, fixture.api);

    try {
      await executor.run({
        runId: "inactive",
        stage: "review",
        command: ["true"],
        timeoutMs: 1_000,
        inactivityTimeoutMs: 20,
      });
      throw new Error("expected inactivity failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxExecutionError);
      expect((error as SandboxExecutionError).cause).toBeInstanceOf(InactivityTimeoutError);
      expect((error as SandboxExecutionError).result.stdout).toBe("hello world\n");
    }
    expect(fixture.calls).toContain("sandbox.kill");
  });

  test("enforces an overall hard timeout without returning partial outputs", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommand = true;
    fixture.outputs.set("/work/partial.json", Buffer.from("partial"));
    const executor = new E2BSandboxExecutor(config, fixture.api);

    const result = await executor.run({
      runId: "hard-timeout",
      stage: "author",
      command: ["true"],
      outputPaths: ["/work/partial.json"],
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      sandboxId: "sb-e2b-test",
      exitCode: 124,
      stdout: "hello world\n",
      stderr: "warning\n",
      outputs: {},
    });
    expect(fixture.calls).toContain("command.kill");
    expect(fixture.calls).toContain("sandbox.kill");
  });

  test("hard timeout settles when command wait and command kill both ignore abort", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommand = true;
    fixture.ignoreCommandAbort = true;
    fixture.commandKillHangs = true;
    fixture.commandKillReleases = false;
    const executor = new E2BSandboxExecutor(config, fixture.api, undefined, fastLifecycleTimings);
    const startedAt = performance.now();

    const result = await executor.run({
      runId: "stuck-wait",
      stage: "author",
      command: ["true"],
      timeoutMs: 100,
    });

    expect(result.exitCode).toBe(124);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(fixture.calls).toContain("command.kill");
    expect(fixture.calls).toContain("sandbox.kill");
  });

  test("hard timeout settles when command start ignores abort", async () => {
    const fixture = new E2BSdkFixture();
    fixture.holdCommandStart = true;
    const executor = new E2BSandboxExecutor(config, fixture.api, undefined, fastLifecycleTimings);

    const result = await executor.run({
      runId: "stuck-command-start",
      stage: "author",
      command: ["true"],
      timeoutMs: 100,
    });

    expect(result.exitCode).toBe(124);
    expect(fixture.calls).not.toContain("command.kill");
    expect(fixture.calls).toContain("sandbox.kill");
  });

  test("bounds partial output reads that ignore abort", async () => {
    const fixture = new E2BSdkFixture();
    fixture.waitError = new Error("transport failed");
    fixture.holdReads = true;
    const executor = new E2BSandboxExecutor(config, fixture.api, undefined, fastLifecycleTimings);
    const startedAt = performance.now();

    const failure = executor.run({
      runId: "stuck-output",
      stage: "review",
      command: ["false"],
      outputPaths: ["/work/one", "/work/two"],
      timeoutMs: 1_000,
    });

    await expect(failure).rejects.toBeInstanceOf(SandboxExecutionError);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(fixture.calls).toContain("files.read:/work/one");
    expect(fixture.calls).toContain("files.read:/work/two");
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });

  test("recovers an ambiguous create by allocation metadata", async () => {
    const fixture = new E2BSdkFixture();
    fixture.createError = new Error("lost create response");
    fixture.listMatchesAllocation = true;
    const sleeps: number[] = [];
    const executor = new E2BSandboxExecutor(config, fixture.api, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    await expect(
      executor.run({ runId: "ambiguous", stage: "author", command: ["true"], timeoutMs: 1_000 }),
    ).rejects.toThrow("lost create response");
    expect(fixture.calls).toContain("Sandbox.kill:sb-late-e2b");
    expect(sleeps).toEqual([]);
    expect(fixture.allocationExists).toBe(false);
  });

  test("does not attempt allocation recovery for an authentication rejection", async () => {
    const fixture = new E2BSdkFixture();
    fixture.createError = new AuthenticationError("invalid API key");

    await expect(
      new E2BSandboxExecutor(config, fixture.api).run({
        runId: "auth-rejected",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("invalid API key");
    expect(fixture.calls).not.toContain("Sandbox.list");
    expect(fixture.calls).not.toContain("Sandbox.kill:sb-late-e2b");
  });

  test("confirms absence even when handle kill reports success", async () => {
    const fixture = new E2BSdkFixture();
    fixture.instanceKillRemovesAllocation = false;
    const executor = new E2BSandboxExecutor(config, fixture.api);

    await expect(
      executor.run({
        runId: "optimistic-handle-kill",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ exitCode: 7 });
    expect(fixture.calls).toContain("Sandbox.getInfo:sb-e2b-test");
    expect(fixture.calls).toContain("Sandbox.kill:sb-e2b-test");
    expect(fixture.allocationExists).toBe(false);
  });

  test("does not treat a false kill result as confirmation without checking absence", async () => {
    const fallback = new E2BSdkFixture();
    fallback.instanceKillResult = false;
    await expect(
      new E2BSandboxExecutor(config, fallback.api).run({
        runId: "fallback-kill",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ exitCode: 7 });
    expect(fallback.calls).toContain("Sandbox.kill:sb-e2b-test");
    expect(fallback.allocationExists).toBe(false);

    const alreadyAbsent = new E2BSdkFixture();
    alreadyAbsent.instanceKillError = new Error("instance transport failed");
    alreadyAbsent.staticKillResult = false;
    alreadyAbsent.staticGetInfoError = new SandboxNotFoundError("Sandbox not found");
    await expect(
      new E2BSandboxExecutor(config, alreadyAbsent.api).run({
        runId: "already-absent",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ exitCode: 7 });
    expect(alreadyAbsent.calls).toContain("Sandbox.getInfo:sb-e2b-test");
  });

  test("fails cleanup when kill returns false and the sandbox still exists", async () => {
    const fixture = new E2BSdkFixture();
    fixture.instanceKillResult = false;
    fixture.staticKillResult = false;
    const executor = new E2BSandboxExecutor(
      config,
      fixture.api,
      async (_delayMs, signal) => {
        signal.throwIfAborted();
      },
      fastLifecycleTimings,
    );

    const failure = executor.run({
      runId: "cleanup-unconfirmed",
      stage: "author",
      command: ["true"],
      timeoutMs: 1_000,
    });

    await expect(failure).rejects.toMatchObject({ name: "E2BSandboxCleanupError" });
    await expect(failure).rejects.toThrow("still exists after repeated kill requests");
    expect(fixture.calls.filter((call) => call === "Sandbox.getInfo:sb-e2b-test")).toHaveLength(3);
    expect(fixture.allocationExists).toBe(true);
  });

  test("bounds a stuck handle kill and falls back to static cleanup", async () => {
    const fixture = new E2BSdkFixture();
    fixture.instanceKillHangs = true;
    const executor = new E2BSandboxExecutor(config, fixture.api, undefined, fastLifecycleTimings);

    await expect(
      executor.run({
        runId: "stuck-handle-kill",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ exitCode: 7 });
    expect(fixture.calls).toContain("Sandbox.kill:sb-e2b-test");
    expect(fixture.allocationExists).toBe(false);
  });

  test("fails when a successful command omits a required output", async () => {
    const fixture = new E2BSdkFixture();
    fixture.exitCode = 0;

    await expect(
      new E2BSandboxExecutor(config, fixture.api).run({
        runId: "missing-output",
        stage: "author",
        command: ["true"],
        outputPaths: ["/work/required.json"],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("exited successfully without output /work/required.json");
    expect(fixture.calls).toContain("sandbox.kill");
    expect(fixture.calls.at(-1)).toBe("Sandbox.getInfo:sb-e2b-test");
  });

  test("falls back to static cleanup and redacts control credentials from cleanup errors", async () => {
    const fixture = new E2BSdkFixture();
    fixture.instanceKillError = new Error("instance kill failed");
    fixture.staticKillError = new Error(`static kill failed with ${config.credentials.apiKey}`);
    const executor = new E2BSandboxExecutor(config, fixture.api);

    const failure = executor.run({
      runId: "cleanup",
      stage: "author",
      command: ["true"],
      timeoutMs: 1_000,
    });

    await expect(failure).rejects.toMatchObject({ name: "E2BSandboxCleanupError" });
    await expect(failure).rejects.toThrow("[redacted]");
    await expect(failure).rejects.not.toThrow(config.credentials.apiKey);
    expect(fixture.calls).toContain("Sandbox.kill:sb-e2b-test");
  });

  test("attaches a redacted cleanup failure to the primary execution error", async () => {
    const fixture = new E2BSdkFixture();
    fixture.waitError = new Error("execution transport failed");
    fixture.instanceKillError = new Error("instance kill failed");
    fixture.staticKillError = new Error(`static cleanup exposed ${config.credentials.apiKey}`);
    const failure = new E2BSandboxExecutor(config, fixture.api).run({
      runId: "execution-and-cleanup-fail",
      stage: "author",
      command: ["false"],
      timeoutMs: 1_000,
    });

    await expect(failure).rejects.toBeInstanceOf(SandboxExecutionError);
    await expect(failure).rejects.toThrow("execution transport failed");
    await expect(failure).rejects.toThrow("cleanup also failed");
    await expect(failure).rejects.toThrow("[redacted]");
    await expect(failure).rejects.not.toThrow(config.credentials.apiKey);
    const error = (await failure.catch((caught) => caught)) as Error & { cleanupError?: Error };
    expect(error.cleanupError?.name).toBe("E2BSandboxCleanupError");
  });
});
