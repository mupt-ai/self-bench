import { ActivityFailure, ApplicationFailure, sleep } from "@temporalio/workflow";
import { SandboxCapacityError } from "../sandbox/contracts.js";

/** Capacity waits belong to the workflow, not a worker slot or an activity execution budget. */
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
