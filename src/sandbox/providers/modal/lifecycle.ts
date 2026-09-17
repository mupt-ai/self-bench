import type { ModalClient, Sandbox } from "modal";
import { attachCleanupFailure } from "../../ownership.js";

/** A local bound: Modal create/exec/filesystem calls do not accept AbortSignal. */
export class ModalDeadline {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #abort: () => void;
  readonly signal: AbortSignal;

  constructor(
    timeoutMs: number,
    readonly parent?: AbortSignal,
  ) {
    this.signal = this.#controller.signal;
    this.#abort = () => this.#controller.abort(parent?.reason);
    parent?.addEventListener("abort", this.#abort, { once: true });
    if (parent?.aborted) this.#abort();
    this.#timer = setTimeout(() => {
      this.#controller.abort(new Error(`Modal local deadline exceeded after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    let abort = (): void => {};
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation(), interrupted]);
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.parent?.removeEventListener("abort", this.#abort);
  }
}

export class ModalCleanupError extends Error {
  // Late SDK settlements remain observable on the error already returned to the caller.
  readonly errors: unknown[] = [];
  constructor(name: string) {
    super(`Modal cleanup could not be confirmed for ${name}; allocation may still exist`);
    this.name = "ModalCleanupError";
  }
}

/** Owns one uniquely named V1 Modal allocation, including a late create response. */
export class ModalAllocation {
  readonly failure: ModalCleanupError;
  #creation: Promise<Sandbox> | undefined;
  #sandbox: Sandbox | undefined;
  #cleaning = false;
  readonly #terminations = new Map<string, Promise<void>>();

  constructor(
    readonly client: ModalClient,
    readonly app: string,
    readonly name: string,
    readonly environment: string | undefined,
    readonly cleanupMs = 5_000,
  ) {
    this.failure = new ModalCleanupError(name);
  }

  create(operation: () => Promise<Sandbox>): Promise<Sandbox> {
    this.#creation = Promise.resolve().then(operation);
    void this.#creation.then(
      (sandbox) => {
        this.#sandbox = sandbox;
        if (this.#cleaning) void this.#terminate(sandbox);
      },
      () => {
        // Create rejection is the execution failure; recovery decides ownership separately.
      },
    );
    return this.#creation;
  }

  #terminate(sandbox: Sandbox): Promise<void> {
    const existing = this.#terminations.get(sandbox.sandboxId);
    if (existing) return existing;
    const deadline = new ModalDeadline(this.cleanupMs);
    const record = (error: unknown): void => {
      if (!this.failure.errors.includes(error)) this.failure.errors.push(error);
    };
    const termination = deadline
      .run(() => {
        const pending = sandbox.terminate({ wait: true });
        void pending.catch(record);
        return pending;
      })
      .then(
        () => undefined,
        (error: unknown) => {
          record(error);
        },
      )
      .finally(() => deadline.dispose());
    this.#terminations.set(sandbox.sandboxId, termination);
    return termination;
  }

  async cleanup(): Promise<void> {
    const creation = this.#creation;
    if (!creation) return;
    this.#cleaning = true;
    const deadline = new ModalDeadline(this.cleanupMs);
    try {
      await deadline.run(async () => {
        if (this.#sandbox) {
          await this.#terminate(this.#sandbox);
          return;
        }
        // A lookup miss (even NotFoundError) only describes running sandboxes now;
        // it cannot prove that an in-flight/ambiguous create allocated nothing.
        let recovered: Sandbox | undefined;
        let lookupError: unknown;
        const recovery = this.client.sandboxes
          .fromName(this.app, this.name, {
            ...(this.environment ? { environment: this.environment } : {}),
          })
          .then(
            async (sandbox) => {
              recovered = sandbox;
              await this.#terminate(sandbox);
            },
            (error: unknown) => {
              lookupError = error;
              if (deadline.signal.aborted) this.failure.errors.push(error);
            },
          );
        await Promise.all([creation.catch(() => undefined), recovery]);
        if (this.#sandbox) await this.#terminate(this.#sandbox);
        if (!this.#sandbox && !recovered) throw lookupError ?? this.failure;
      });
    } catch (error) {
      if (error !== this.failure) this.failure.errors.push(error);
      throw this.failure;
    } finally {
      deadline.dispose();
    }
    if (this.failure.errors.length) throw this.failure;
  }
}

export function withCleanupFailure(primary: unknown, cleanupError: unknown): Error {
  return attachCleanupFailure(primary, cleanupError, {
    fallbackMessage: "Modal execution and cleanup failed",
  });
}
