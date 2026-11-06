import type { EvaluationRoutesOptions } from "../../src/api/routes/evaluations.js";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import type { BenchmarkStore } from "../../src/db/benchmarks.js";
import { addBenchmarkWith, type BenchmarkAddInput } from "../../src/evaluation/benchmark-add.js";
import { createBenchmarkAddActivities } from "../../src/evaluation/benchmark-add-activities.js";
import type { runCommand } from "../../src/lib/process.js";

/** The fixture's route options, and a stand-in for Harbor when a dataset is added. */
export type FixtureRoutes = Partial<EvaluationRoutesOptions> & {
  registryCommand?: typeof runCommand;
};

/**
 * Runs the add workflow's steps in the request, with the worker's activities, so a test sees the
 * box settled when the add returns.
 */
export function inlineBenchmarkAdder(options: {
  artifacts: ArtifactStore;
  benchmarks: BenchmarkStore;
  env: NodeJS.ProcessEnv;
  registryCommand?: typeof runCommand | undefined;
}) {
  const activities = createBenchmarkAddActivities({
    artifacts: options.artifacts,
    store: options.benchmarks,
    env: options.env,
    ...(options.registryCommand ? { command: options.registryCommand } : {}),
  });
  return (input: BenchmarkAddInput) => addBenchmarkWith(activities, input);
}
