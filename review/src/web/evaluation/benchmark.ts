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
/** A custom point's endpoint, and its public number when another endpoint shares its setting. */
export interface CustomEndpoint {
  endpoint: string;
  number?: number;
}

export function dollars(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : value < 1 ? 3 : 2)}`;
}
