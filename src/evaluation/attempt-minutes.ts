/** Wall-clock minutes an attempt took, or undefined when it was not timed both ways. */
export function attemptMinutes(attempt: { startedAt?: string; finishedAt?: string }) {
  if (!attempt.startedAt || !attempt.finishedAt) return undefined;
  return (Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)) / 60_000;
}

/**
 * Minutes a trial's agent took, from Harbor's agent phase when the trial has it, else the trial's
 * wall-clock time (setup and grading included) for trials recorded before that.
 */
export function trialMinutes(trial: {
  startedAt?: string;
  finishedAt?: string;
  agentStartedAt?: string;
  agentFinishedAt?: string;
}) {
  if (trial.agentStartedAt && trial.agentFinishedAt)
    return attemptMinutes({ startedAt: trial.agentStartedAt, finishedAt: trial.agentFinishedAt });
  return attemptMinutes(trial);
}
