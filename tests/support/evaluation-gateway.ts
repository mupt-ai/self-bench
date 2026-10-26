import type { TrialGateway } from "../../src/evaluation/runner.js";

/** The API's address and signing secret as a test worker's trial keys name them. */
export const TEST_GATEWAY_API = { url: "https://api.selfbench.test", secret: "g".repeat(40) };

/**
 * A model gateway for runner tests: trials get its connection, and read back `costs`, what it
 * recorded each trial's calls cost (by trial tag, `<evaluation>/<index>`), none by default.
 */
export function testGateway(
  costs: Readonly<Record<string, { costUsd: number; complete: boolean }>> = {},
): TrialGateway {
  return {
    api: TEST_GATEWAY_API,
    usage: { trialCost: async (_orgId, trial) => costs[trial] },
  };
}
