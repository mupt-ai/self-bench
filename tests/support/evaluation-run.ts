import type { ArtifactStore } from "../../src/artifacts/index.js";
import { explainTrialFailure } from "../../src/evaluation/failure-summary.js";
import { failTrial, finishEvaluation, startEvaluation } from "../../src/evaluation/lifecycle.js";
import { environmentSecrets, redactOutput } from "../../src/evaluation/output.js";
import { executeTrial, type RunnerOptions } from "../../src/evaluation/runner.js";
import { trialInput } from "../../src/evaluation/trial-input.js";
import type { EvaluationInput } from "../../src/evaluation/types.js";
import { runEvaluationTrials } from "../../src/evaluation/workflow.js";
import { runCommand } from "../../src/lib/process.js";

/**
 * The evaluation workflow's own orchestration over the record and runner directly, in place of
 * Temporal activities: one trial at a time, each given only its own task as a trial workflow is.
 */
export function runEvaluation(
  store: ArtifactStore,
  input: EvaluationInput,
  options: RunnerOptions,
): Promise<void> {
  return runEvaluationTrials(
    input,
    {
      startSolverEvaluation: (input) => startEvaluation(store, input),
      failSolverTrial: (input, index) => failTrial(store, input, index),
      finishSolverEvaluation: (input) => finishEvaluation(store, input),
    },
    async (input, index) => {
      const trial = trialInput(input, index);
      await executeTrial(store, trial, index, options);
      // As the trial workflow does, once the trial has ended.
      if (input.explainFailures)
        await explainTrialFailure(store, trial, index, {
          command: options.command ?? runCommand,
          env: options.env,
          redact: (text) => redactOutput(text, environmentSecrets(options.env ?? {})),
        });
    },
    1,
  );
}
