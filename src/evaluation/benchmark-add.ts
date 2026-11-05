/**
 * Adding a Harbor registry dataset as a benchmark, off the API: the API saves an `adding` box and
 * starts selfBenchBenchmarkAddWorkflow, and a Harbor worker, where trials already run Harbor on
 * these tasks, downloads, checks, and freezes them. This module is shared with the workflow
 * bundle, so it imports nothing that needs Node.
 */

import type { EvaluationInput } from "./types.js";

/** One task as frozen (FrozenTask in db/benchmarks.ts): its digest, name, bundle, and limits. */
type FrozenBenchmarkTask = EvaluationInput["tasks"][number];

/** Which box to fill, and the dataset it names. */
export interface BenchmarkAddInput {
  /** The benchmark's row (benchmarks table). */
  id: number;
  /** `org/name` */
  name: string;
  ref: string;
}

export interface BenchmarkAddActivities {
  /** Downloads `name@ref` on a Harbor worker, checks every task, and stores each bundle. */
  freezeBenchmarkTasks(input: BenchmarkAddInput): Promise<FrozenBenchmarkTask[]>;
  finishBenchmark(id: number, tasks: FrozenBenchmarkTask[]): Promise<void>;
  failBenchmark(id: number, error: string): Promise<void>;
}

/**
 * The message a person can act on: Temporal wraps an activity's error ("Activity task failed")
 * around the one it threw, so the innermost message is the dataset's own.
 */
function failureMessage(error: unknown): string {
  let current = error;
  let message = "Dataset could not be added";
  while (current instanceof Error) {
    if (current.message) message = current.message;
    current = current.cause;
  }
  return message;
}

/** Freezes the dataset's tasks and settles the box: ready with them, or failed with why. */
export async function addBenchmarkWith(
  activities: BenchmarkAddActivities,
  input: BenchmarkAddInput,
): Promise<void> {
  let tasks: FrozenBenchmarkTask[];
  try {
    tasks = await activities.freezeBenchmarkTasks(input);
  } catch (error) {
    await activities.failBenchmark(input.id, failureMessage(error));
    return;
  }
  await activities.finishBenchmark(input.id, tasks);
}
