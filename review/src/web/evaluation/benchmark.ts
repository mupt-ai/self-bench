import type { CredentialInfo } from "../../../../src/db/credentials";
import { eligibleTrial } from "../../../../src/evaluation/eligible";
import {
  endpointNumber,
  type NumberedSetting,
  publicIds,
} from "../../../../src/public/endpoint-numbers";
import type { EvaluationRun } from "./api";

export interface BenchmarkPoint {
  id: string;
  runId: string;
  name: string;
  /** The model's display name, without the reasoning level `name` adds. */
  modelLabel: string;
  /** Who serves the model: a model provider, OpenRouter, or `custom` for a custom endpoint. */
  provider: string;
  /** The model as the run called it, "vendor/model", with no provider in front for a custom one. */
  model: string;
  /** The recorded reasoning level, or "default" when none was recorded. */
  thinking: string;
  /** The model credential the run used; for a custom model, it holds the endpoint. */
  credentialId?: string;
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
          modelLabel: run.modelLabel,
          ...runModel(run),
          thinking: run.thinking ?? "default",
          ...(run.credentials ? { credentialId: run.credentials.modelCredentialId } : {}),
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
/** A custom point's endpoint, and its public number when another endpoint shares its setting. */
export interface CustomEndpoint {
  endpoint: string;
  number?: number;
}

/**
 * Each custom point's endpoint, by point id, and the "Endpoint N" it would be labelled with on the
 * public page if its setting were released with the others here: numbered as a release numbers
 * them, from the same private key. Points whose credential is gone are left out.
 */
export function customEndpoints(
  points: readonly BenchmarkPoint[],
  credentials: readonly CredentialInfo[],
): Map<string, CustomEndpoint> {
  const byId = new Map(credentials.map((credential) => [credential.id, credential]));
  const settings = new Map<string, NumberedSetting>();
  const found = new Map<string, { key: string; endpoint: string }>();
  for (const point of points) {
    const credential = point.credentialId ? byId.get(point.credentialId) : undefined;
    if (point.provider !== "custom" || !credential?.endpoint) continue;
    // The release's setting identity (src/public/release-results.ts), endpoint last.
    const parts = [point.model, point.harness, point.provider, credential.auth, point.thinking];
    const key = JSON.stringify([...parts, credential.endpoint]);
    settings.set(key, { key, id: parts.join("|"), custom: true });
    found.set(point.id, { key, endpoint: credential.endpoint });
  }
  const ids = publicIds([...settings.values()]);
  return new Map(
    [...found].map(([id, { key, endpoint }]) => {
      const number = endpointNumber(ids.get(key) ?? "");
      return [id, number === undefined ? { endpoint } : { endpoint, number }];
    }),
  );
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
