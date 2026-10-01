export interface BenchmarkPoint {
  id: string;
  runId: string;
  name: string;
  /** The model's display name, without the reasoning level `name` adds. */
  modelLabel: string;
  /** The model's vendor, as a release names it, or `custom` for a custom endpoint's model. */
  provider: string;
  /** The model as a release names it, "vendor/model", or a custom endpoint's typed name. */
  model: string;
  /** The recorded reasoning level, or "default" when none was recorded. */
  thinking: string;
  harness: string;
  accuracy: number;
  cost: number;
  tasks: number;
  datasetKey: string;
}
export function dollars(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : value < 1 ? 3 : 2)}`;
}
