import { describe, expect, test } from "bun:test";
import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
  StartedSandbox,
} from "../../src/sandbox/contracts.js";
import { TimeoutCappedSandboxExecutor } from "../../src/sandbox/timeout.js";

const capMs = 45 * 60 * 1_000;

class RecordingExecutor implements SandboxExecutor {
  readonly requests: SandboxRequest[] = [];
  closed = false;

  async run(request: SandboxRequest, _options?: SandboxRunOptions): Promise<SandboxResult> {
    this.requests.push(request);
    return { sandboxId: "test", exitCode: 0, stdout: "", stderr: "", outputs: {} };
  }

  async start(request: SandboxRequest): Promise<StartedSandbox> {
    this.requests.push(request);
    return {
      sandboxId: "test",
      stage: request.stage,
      startedAt: new Date(0).toISOString(),
      expiresAt: new Date(request.timeoutMs).toISOString(),
    };
  }

  async stop(): Promise<void> {}

  close(): void {
    this.closed = true;
  }
}

describe("TimeoutCappedSandboxExecutor", () => {
  test("caps only requests above the configured provider ceiling", async () => {
    const delegate = new RecordingExecutor();
    const executor = new TimeoutCappedSandboxExecutor(delegate, capMs);
    const request = (timeoutMs: number) => ({
      runId: "run",
      stage: "stage",
      command: ["true"],
      timeoutMs,
    });

    await executor.run(request(2 * 60 * 60 * 1_000));
    await executor.run(request(15 * 60 * 1_000));
    await executor.start(request(2 * 60 * 60 * 1_000));

    expect(delegate.requests.map(({ timeoutMs }) => timeoutMs)).toEqual([
      capMs,
      15 * 60 * 1_000,
      capMs,
    ]);
  });

  test("delegates lifecycle and rejects invalid caps", () => {
    const delegate = new RecordingExecutor();
    const executor = new TimeoutCappedSandboxExecutor(delegate, capMs);

    executor.close();

    expect(delegate.closed).toBe(true);
    expect(() => new TimeoutCappedSandboxExecutor(delegate, 99)).toThrow("at least 100ms");
  });
});
