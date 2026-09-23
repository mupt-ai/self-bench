import type { SandboxExecutor } from "../../src/sandbox/contracts.js";

/** An executor whose `run` is the given function; starting a detached sandbox is not expected. */
export function runOnlyExecutor(run: SandboxExecutor["run"]): SandboxExecutor {
  return {
    run,
    start: async () => {
      throw new Error("this test does not start detached sandboxes");
    },
    stop: async () => {},
    close: () => {},
  };
}
