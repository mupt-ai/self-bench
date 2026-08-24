import { describe, expect, test } from "bun:test";
import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "../../src/sandbox/contracts.js";
import {
  HOBBY_VERCEL_TIMEOUT_CAP_MS,
  TimeoutCappedSandboxExecutor,
} from "../../src/sandbox/timeout.js";

class RecordingExecutor implements SandboxExecutor {
  readonly requests: SandboxRequest[] = [];
  closed = false;

  async run(request: SandboxRequest, _options?: SandboxRunOptions): Promise<SandboxResult> {
    this.requests.push(request);
    return { sandboxId: "test", exitCode: 0, stdout: "", stderr: "", outputs: {} };
  }

  close(): void {
    this.closed = true;
  }
}

describe("TimeoutCappedSandboxExecutor", () => {
  test("caps only requests above the configured provider ceiling", async () => {
    const delegate = new RecordingExecutor();
    const executor = new TimeoutCappedSandboxExecutor(delegate, HOBBY_VERCEL_TIMEOUT_CAP_MS);
    const run = async (stage: string, timeoutMs: number): Promise<void> => {
      await executor.run({ runId: "run", stage, command: ["true"], timeoutMs });
    };

    await run("discover-0-0", 45 * 60 * 1_000);
    await run("author-candidate", 2 * 60 * 60 * 1_000);
    await run("validation-repair-task", 2 * 60 * 60 * 1_000);
    await run("review-task", 15 * 60 * 1_000);
    await run("repair-task", 2 * 60 * 60 * 1_000);
    await run("standalone-repair", 2 * 60 * 60 * 1_000);

    expect(delegate.requests.map(({ timeoutMs }) => timeoutMs)).toEqual([
      HOBBY_VERCEL_TIMEOUT_CAP_MS,
      HOBBY_VERCEL_TIMEOUT_CAP_MS,
      HOBBY_VERCEL_TIMEOUT_CAP_MS,
      15 * 60 * 1_000,
      HOBBY_VERCEL_TIMEOUT_CAP_MS,
      HOBBY_VERCEL_TIMEOUT_CAP_MS,
    ]);
    expect(delegate.requests.map(({ stage }) => stage)).toEqual([
      "discover-0-0",
      "author-candidate",
      "validation-repair-task",
      "review-task",
      "repair-task",
      "standalone-repair",
    ]);
  });

  test("delegates lifecycle and rejects invalid caps", () => {
    const delegate = new RecordingExecutor();
    const executor = new TimeoutCappedSandboxExecutor(delegate, HOBBY_VERCEL_TIMEOUT_CAP_MS);

    executor.close();

    expect(delegate.closed).toBe(true);
    expect(() => new TimeoutCappedSandboxExecutor(delegate, 99)).toThrow("at least 100ms");
  });
});
