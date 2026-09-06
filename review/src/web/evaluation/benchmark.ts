import type { EvaluationRun } from "./api";

export interface BenchmarkPoint {
  id: string;
  runId: string;
  name: string;
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
      if (
        !trials.length ||
        trials.some(
          (trial) =>
            trial.status !== "completed" ||
            !trial.modelVerified ||
            trial.apiCostUsd === undefined ||
            !Number.isFinite(trial.apiCostUsd) ||
            trial.apiCostUsd < 0 ||
            ![0, 1].includes(trial.rewards.reward ?? -1),
        )
      )
        return [];
      return [
        {
          id: `${run.id}/${harness}`,
          runId: run.id,
          name: `${run.modelLabel} · ${run.thinking ?? "unrecorded effort"}`,
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
