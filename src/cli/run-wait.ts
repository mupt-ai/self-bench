export interface PolledRunStatus {
  readonly phase: string;
  readonly error?: unknown;
  readonly [key: string]: unknown;
}

export interface WaitForRunOptions {
  readonly poll: () => Promise<PolledRunStatus>;
  readonly onPhase?: (status: PolledRunStatus) => void;
  readonly intervalMs?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

const FAILED_PHASES = new Set(["blocked", "failed", "cancelled"]);

export async function waitForRun(options: WaitForRunOptions): Promise<PolledRunStatus> {
  const intervalMs = options.intervalMs ?? 2_000;
  const delay = options.delay ?? defaultDelay;
  let previousPhase: string | undefined;

  while (true) {
    const status = await options.poll();
    if (status.phase !== previousPhase) {
      options.onPhase?.(status);
      previousPhase = status.phase;
    }
    if (status.phase === "complete") {
      return status;
    }
    if (FAILED_PHASES.has(status.phase)) {
      const detail = typeof status.error === "string" ? `: ${status.error}` : "";
      throw new Error(`SelfBench run ${status.phase}${detail}`);
    }
    await delay(intervalMs);
  }
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
