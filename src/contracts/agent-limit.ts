/**
 * How many minutes a solver's agent may work on one task. Each repository sets its own
 * (repos.agent_minutes), and an evaluation freezes it when it starts. It is the only time limit
 * to change: every other limit a trial runs under is derived from it here.
 */
export const AGENT_MINUTES = { default: 40, min: 10, max: 90 } as const;

// Starting the sandbox, setting up the agent, grading and collecting artifacts around the agent.
const HARBOR_OVERHEAD_MINUTES = 80;
// Downloading the task bundle before Harbor and uploading its artifacts after.
const TRANSFER_MINUTES = 30;

export function isAgentMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= AGENT_MINUTES.min &&
    value <= AGENT_MINUTES.max
  );
}

/** The limits one solver trial runs under, from its evaluation's agent minutes. */
export function trialTimeouts(agentMinutes: number = AGENT_MINUTES.default): {
  /** Harbor's agent phase, written into the trial's task.toml. */
  agentSeconds: number;
  /** The whole `harbor run` process. */
  harborMs: number;
  /** The Temporal activity that runs the trial. */
  activityMs: number;
} {
  const harborMs = (agentMinutes + HARBOR_OVERHEAD_MINUTES) * 60_000;
  return {
    agentSeconds: agentMinutes * 60,
    harborMs,
    activityMs: harborMs + TRANSFER_MINUTES * 60_000,
  };
}
