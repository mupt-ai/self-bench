import type { EvaluationInput } from "./types.js";

/**
 * The evaluation input narrowed to the one task a trial runs. Trials are ordered task by task, one
 * per harness (see initialEvaluation). Each trial workflow's start is kept in the evaluation's
 * history, so passing every task to every trial would grow that history with the square of the
 * evaluation's size.
 */
export function trialInput(input: EvaluationInput, index: number): EvaluationInput {
  const task = input.tasks[Math.floor(index / input.harnesses.length)];
  return { ...input, tasks: task ? [task] : [] };
}

/**
 * Whether an evaluation on this sandbox builds each task's images before the task's trials start
 * (prepareTaskImages): Modal and E2B keep a built image or template for every later trial.
 */
export function preparesTaskImages(sandbox: EvaluationInput["sandbox"]): boolean {
  return sandbox === "modal" || sandbox === "e2b";
}

/**
 * Sets each evaluation's maxTrials from the limits (maxSandboxes) of the credentials its trials
 * hold a slot of. A comparison's evaluations start together, so they split the sandbox account's
 * limit, and those calling one model credential split its limit too. Each runs at least one trial,
 * so more evaluations than slots go over; their trials wait for a slot.
 */
export function splitCredentialLimits(
  inputs: EvaluationInput[],
  limitOf: (credentialId: string) => number | undefined,
): void {
  const share = (id: string | undefined) => {
    const limit = id ? limitOf(id) : undefined;
    const sharing = inputs.filter(
      ({ credentials, subagent }) =>
        credentials?.sandboxCredentialId === id ||
        credentials?.modelCredentialId === id ||
        subagent?.credentialId === id,
    ).length;
    return limit ? Math.max(1, Math.floor(limit / sharing)) : Number.POSITIVE_INFINITY;
  };
  for (const input of inputs) {
    const maxTrials = Math.min(
      share(input.credentials?.sandboxCredentialId),
      share(input.credentials?.modelCredentialId),
      share(input.subagent?.credentialId),
    );
    if (Number.isFinite(maxTrials)) input.maxTrials = maxTrials;
  }
}
