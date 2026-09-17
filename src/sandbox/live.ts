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

type SupervisionSettlement =
  | { readonly status: "pending" }
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly error: unknown; readonly lateError?: unknown };

export interface Supervision {
  /** Signals command exit once; every call returns the same bounded settlement promise. */
  finish(): Promise<void>;
  /** Read current finish state, including a hook rejection arriving after the grace expired. */
  settlement(): SupervisionSettlement;
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
    let settlement: SupervisionSettlement = { status: "pending" };
    let finishing: Promise<void> | undefined;
    void hook.catch((error: unknown) => {
      if (settlement.status === "failed" && error !== settlement.error) {
        // Keep the authoritative finish failure while retaining late hook diagnostics.
        settlement = { ...settlement, lateError: error };
      }
    });
    const settle = async (): Promise<void> => {
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
        settlement = { status: "succeeded" };
      } catch (error) {
        settlement = { status: "failed", error };
        throw error;
      } finally {
        clearTimeout(timer);
        active = false;
        if (this.#entries.get(sandboxId) === backing) this.#entries.delete(sandboxId);
      }
    };
    return {
      settlement: () => settlement,
      finish: () => {
        if (!finishing) {
          let resolveFinish!: () => void;
          let rejectFinish!: (error: unknown) => void;
          finishing = new Promise<void>((resolve, reject) => {
            resolveFinish = resolve;
            rejectFinish = reject;
          });
          // Cache before abort dispatch: an abort listener may reenter finish().
          void settle().then(resolveFinish, rejectFinish);
          void finishing.catch(() => undefined);
        }
        return finishing;
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
