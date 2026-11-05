import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../artifacts/index.js";
import type { BenchmarkStore } from "../db/benchmarks.js";
import { runCommand } from "../lib/process.js";
import type { BenchmarkAddActivities } from "./benchmark-add.js";
import { freezeRegistryTasks } from "./frozen-tasks.js";

/** How often a freeze tells Temporal it is alive while Harbor downloads. */
const HEARTBEAT_MS = 30_000;

/** Keeps a long activity's heartbeat going; outside an activity (tests), does nothing. */
async function heartbeating<T>(work: () => Promise<T>): Promise<T> {
  let context: Context | undefined;
  try {
    context = Context.current();
  } catch {
    return work();
  }
  const timer = setInterval(() => context?.heartbeat(), HEARTBEAT_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * The freeze runs on the Harbor queue, beside trials: it needs Harbor and the artifact store, and
 * checks tasks against that worker's own environment, the one a trial would run them with. The
 * box's record is written from the workflow queue, which holds the database.
 */
export function createBenchmarkAddActivities(options: {
  artifacts: ArtifactStore;
  store?: BenchmarkStore;
  env?: NodeJS.ProcessEnv;
  command?: typeof runCommand;
}): BenchmarkAddActivities {
  const { artifacts, store, env = process.env, command = runCommand } = options;
  const records = () => {
    if (!store) throw new Error("Benchmarks need the database");
    return store;
  };
  return {
    freezeBenchmarkTasks: ({ name, ref }) =>
      heartbeating(() => freezeRegistryTasks(artifacts, [`${name}@${ref}`], env, command)),
    finishBenchmark: (id, tasks) => records().finish(id, tasks),
    failBenchmark: (id, error) => records().fail(id, error),
  };
}
