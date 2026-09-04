import type { LiveSandbox, SandboxExecResult, SandboxRunOptions } from "./contracts.js";
import { assertSandboxWorkPath } from "./request-validation.js";

export type LiveSandboxBacking = Omit<LiveSandbox, "sandboxId">;

export interface Supervision {
  /** Signals command exit, waits for the onLive hook, and unregisters the sandbox. */
  finish(): Promise<void>;
}

/**
 * Tracks sandboxes whose main command is running so an executor can serve execute/readFile/
 * writeFile by ID, and runs the caller's onLive hook alongside the command.
 */
export class LiveSandboxRegistry {
  readonly #entries = new Map<string, LiveSandboxBacking>();

  start(sandboxId: string, backing: LiveSandboxBacking, options: SandboxRunOptions): Supervision {
    this.#entries.set(sandboxId, backing);
    const exited = new AbortController();
    const live: LiveSandbox = {
      sandboxId,
      execute: (command) => backing.execute(command),
      readFile: (path) => backing.readFile(path),
      writeFile: (path, contents) => backing.writeFile(path, contents),
    };
    const hook = options.onLive
      ? Promise.resolve().then(() => options.onLive?.(live, exited.signal))
      : Promise.resolve();
    hook.catch(() => undefined);
    return {
      finish: async () => {
        exited.abort(new Error("sandbox command exited"));
        try {
          await hook;
        } finally {
          this.#entries.delete(sandboxId);
        }
      },
    };
  }

  execute(sandboxId: string, command: readonly string[]): Promise<SandboxExecResult> {
    if (command.length === 0) {
      throw new Error("sandbox command must not be empty");
    }
    return this.#require(sandboxId).execute(command);
  }

  readFile(sandboxId: string, path: string): Promise<Uint8Array | undefined> {
    assertSandboxWorkPath(path);
    return this.#require(sandboxId).readFile(path);
  }

  writeFile(sandboxId: string, path: string, contents: Uint8Array | string): Promise<void> {
    assertSandboxWorkPath(path);
    return this.#require(sandboxId).writeFile(path, contents);
  }

  #require(sandboxId: string): LiveSandboxBacking {
    const backing = this.#entries.get(sandboxId);
    if (!backing) {
      throw new Error(`sandbox ${sandboxId} is not running`);
    }
    return backing;
  }
}
