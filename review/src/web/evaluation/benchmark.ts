import { eligibleTrial } from "../../../../src/evaluation/eligible";
import type { EvaluationRun } from "./api";

export interface BenchmarkPoint {
  id: string;
  runId: string;
  name: string;
  /** Who serves the model: a model provider, OpenRouter, or `custom` for a custom endpoint. */
  provider: string;
  /** The model as the run called it, "vendor/model", with no provider in front for a custom one. */
  model: string;
  harness: string;
  accuracy: number;
  cost: number;
  tasks: number;
  datasetKey: string;
}
export function benchmarkPoints(runs: EvaluationRun[]): BenchmarkPoint[] {
  return runs.flatMap((run) => {
    if (run.status !== "completed" || !run.datasetKey) return [];
    return run.harnesses.flatMap((harness) => {
      const trials = run.trials.filter((trial) => trial.harness === harness);
      if (!trials.length || !trials.every(eligibleTrial)) return [];
      return [
        {
          id: `${run.id}/${harness}`,
          runId: run.id,
          name: `${run.modelLabel} · ${run.thinking ?? "unrecorded effort"}`,
          ...runModel(run),
          harness,
          accuracy:
            (trials.reduce((sum, trial) => sum + (trial.rewards.reward ?? 0), 0) / trials.length) *
            100,
          cost: trials.reduce((sum, trial) => sum + (trial.apiCostUsd ?? 0), 0) / trials.length,
          tasks: trials.length,
          datasetKey: run.datasetKey ?? "",
        },
      ];
    });
  });
}
/**
 * A run's provider and model. A custom endpoint's run names its model "openai/<model>", since
 * it speaks OpenAI's API, so its model loses that prefix. Runs from before credentials were
 * recorded take the provider from the model's name.
 */
function runModel(run: EvaluationRun): { provider: string; model: string } {
  if (run.model === "custom") {
    return { provider: "custom", model: run.modelName.replace(/^[^/]+\//, "") };
  }
  return {
    provider: run.credentials?.provider ?? run.modelName.split("/")[0] ?? "",
    model: run.modelName,
  };
}
export function dollars(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : value < 1 ? 3 : 2)}`;
}
export function runAccuracy(run: EvaluationRun, harness: string): number | undefined {
  const trials = run.trials.filter((trial) => trial.harness === harness);
  if (
    !trials.length ||
    trials.some(
      (trial) => trial.status !== "completed" || ![0, 1].includes(trial.rewards.reward ?? -1),
    )
  )
    return undefined;
  return (
    (trials.reduce((sum, trial) => sum + (trial.rewards.reward ?? 0), 0) / trials.length) * 100
  );
}
