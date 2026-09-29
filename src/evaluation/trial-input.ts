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
