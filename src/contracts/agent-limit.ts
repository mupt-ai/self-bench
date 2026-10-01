/** Minutes a solver's agent may work on one task, set per repo and frozen into each evaluation. */
export const AGENT_MINUTES = { default: 40, min: 10, max: 90 } as const;

/**
 * Every limit a trial runs under, from its agent minutes: the agent itself, the `harbor run`
 * around it (sandbox start, agent setup, grading: 80 minutes), and the Temporal activity around
 * that (bundle download and artifact upload: 30 more).
 */
export function trialTimeouts(agentMinutes: number = AGENT_MINUTES.default) {
  const harborMs = (agentMinutes + 80) * 60_000;
  return { agentSeconds: agentMinutes * 60, harborMs, activityMs: harborMs + 30 * 60_000 };
}
