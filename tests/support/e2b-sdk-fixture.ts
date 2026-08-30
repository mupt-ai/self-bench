import { type CommandHandle, type SandboxInfo, SandboxNotFoundError } from "e2b";
import type { E2BSandboxApi, E2BSandboxHandle } from "../../src/sandbox/providers/e2b/executor.js";

export const e2bFixtureConfig = {
  kind: "e2b" as const,
  image: "selfbench-runtime:v1",
  timeoutCapMs: 60 * 60 * 1_000,
  credentials: { apiKey: "e2b_test_key", domain: "custom.e2b.example" },
};

export const fastLifecycleTimings = {
  cleanupCallTimeoutMs: 20,
  cleanupRecoveryDelaysMs: [0, 1],
  cleanupTimeoutMs: 100,
  commandKillGraceMs: 5,
  diagnosticTimeoutMs: 20,
};

export class E2BSdkFixture {
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
