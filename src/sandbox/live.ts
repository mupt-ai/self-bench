import type { LiveSandbox, SandboxExecResult, SandboxRunOptions } from "./contracts.js";
import { assertSandboxWorkPath } from "./request-validation.js";

export type LiveSandboxBacking = Omit<LiveSandbox, "sandboxId">;

export class SandboxSupervisionError extends Error {
  readonly ownershipFailure = true;
  constructor(sandboxId: string) {
    super(`sandbox ${sandboxId} supervision did not settle`);
    this.name = "SandboxSupervisionError";
  }
}

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

  constructor(private readonly finishTimeoutMs = 5_000) {
    if (!Number.isInteger(finishTimeoutMs) || finishTimeoutMs < 1)
      throw new Error("invalid supervision deadline");
  }

  start(sandboxId: string, backing: LiveSandboxBacking, options: SandboxRunOptions): Supervision {
    if (this.#entries.has(sandboxId)) throw new Error(`sandbox ${sandboxId} already registered`);
    this.#entries.set(sandboxId, backing);
    let active = true;
    const ensureActive = () => {
      if (!active) throw new Error(`sandbox ${sandboxId} is not running`);
    };
    const exited = new AbortController();
    const live: LiveSandbox = {
      sandboxId,
      execute: (command) => {
        ensureActive();
        return this.execute(sandboxId, command);
      },
      readFile: (path) => {
        ensureActive();
        return this.readFile(sandboxId, path);
      },
      writeFile: (path, contents) => {
        ensureActive();
        return this.writeFile(sandboxId, path, contents);
      },
    };
    const hook = options.onLive
      ? Promise.resolve().then(() => options.onLive?.(live, exited.signal))
      : Promise.resolve();
    hook.catch(() => undefined);
    return {
      finish: async () => {
        exited.abort(new Error("sandbox command exited"));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            hook,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new SandboxSupervisionError(sandboxId)),
                this.finishTimeoutMs,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          active = false;
          if (this.#entries.get(sandboxId) === backing) this.#entries.delete(sandboxId);
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
