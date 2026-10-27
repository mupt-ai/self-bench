import { ActivityFailure, ApplicationFailure, sleep } from "@temporalio/workflow";
import { SandboxCapacityError } from "../sandbox/contracts.js";

/**
 * Starts an activity, and while it is refused at a credential's or provider's sandbox limit
 * (SandboxCapacityError, src/sandbox/capacity.ts), waits 1, 2, 4, then 8 minutes between tries.
 * The wait belongs to the workflow, so it holds no worker slot and spends no activity retries.
 */
export async function whenSandboxFree<T>(start: () => Promise<T>): Promise<T> {
  for (let minutes = 1; ; minutes = Math.min(minutes * 2, 8)) {
    try {
      return await start();
    } catch (error) {
      const full =
        error instanceof ActivityFailure &&
        error.cause instanceof ApplicationFailure &&
        error.cause.type === SandboxCapacityError.type;
      if (!full) throw error;
      await sleep(minutes * 60_000);
    }
  }
}
