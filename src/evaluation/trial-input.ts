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
