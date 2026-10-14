import type { JudgeNeeds } from "../../../../src/harnesses/harbor/host-variables";
import type { TaskFiles } from "../../types";
import { requestJson } from "../api";

/** A Harbor registry dataset the org added (src/db/benchmarks.ts), with how many runs it has. */
export interface Benchmark {
  id: number;
  /** The registry package, `org/name`. */
  name: string;
  ref: string;
  tasks: number;
  runs: number;
  addedAt: string;
  /** The judge variables its tasks' LLM judge reads (the Run page's judge credential). */
  judge?: JudgeNeeds;
}

function benchmarksPath(org: string): string {
  return `/api/orgs/${encodeURIComponent(org)}/benchmarks`;
}

export async function fetchBenchmarks(org: string): Promise<Benchmark[]> {
  return (await requestJson<{ benchmarks: Benchmark[] }>(benchmarksPath(org))).benchmarks;
}

/** Adds `reference` (`org/name@ref`); the server downloads and checks every task first. */
export async function addBenchmark(org: string, reference: string): Promise<Benchmark> {
  const body = await requestJson<{ benchmark: Omit<Benchmark, "runs"> }>(benchmarksPath(org), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference }),
  });
  return { ...body.benchmark, runs: 0 };
}

export async function removeBenchmark(org: string, name: string): Promise<void> {
  await requestJson<{ ok: true }>(`${benchmarksPath(org)}/${name}`, { method: "DELETE" });
}

/** A task the benchmark had when added: its registry digest (`runId`) and package name. */
export interface BenchmarkTask {
  runId: string;
  taskId: string;
  /** `org/name@sha256:…` */
  registry?: string;
}

export async function fetchBenchmarkTasks(org: string, name: string): Promise<BenchmarkTask[]> {
  return (await requestJson<{ tasks: BenchmarkTask[] }>(`${benchmarksPath(org)}/${name}/tasks`))
    .tasks;
}

/** One task's files, as frozen when the benchmark was added. */
export function benchmarkTaskFiles(org: string, name: string, taskId: string): Promise<TaskFiles> {
  return requestJson<TaskFiles>(
    `${benchmarksPath(org)}/${name}/task-files?task=${encodeURIComponent(taskId)}`,
  );
}
