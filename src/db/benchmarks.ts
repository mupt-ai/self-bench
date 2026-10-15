import { and, asc, count, eq, getTableColumns } from "drizzle-orm";
import type { EvaluationInput } from "../evaluation/types.js";
import type { Database } from "./client.js";
import { benchmarkSummaries, benchmarks } from "./schema.js";

/** A task frozen from the registry (freezeRegistryTasks): its digest, name, and bundle. */
export type FrozenTask = EvaluationInput["tasks"][number];

/** A Harbor registry dataset an org added to run models on (schema's `benchmarks`). */
export interface Benchmark {
  id: number;
  orgId: number;
  /** The registry package, `org/name`. */
  name: string;
  ref: string;
  tasks: number;
  addedAt: string;
}

export function createBenchmarkStore(db: Database) {
  // A dataset's task list can run to hundreds of entries; only the Dataset tab reads it.
  const { taskList: _, ...columns } = getTableColumns(benchmarks);
  const benchmark = (row: Omit<typeof benchmarks.$inferSelect, "taskList">): Benchmark => ({
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    ref: row.ref,
    tasks: row.tasks,
    addedAt: row.addedAt.toISOString(),
  });
  return {
    /** The org's benchmarks in the order they were added, with how many runs each has. */
    async list(orgId: number): Promise<(Benchmark & { runs: number })[]> {
      const rows = await db
        .select({ benchmark: columns, runs: count(benchmarkSummaries.id) })
        .from(benchmarks)
        .leftJoin(benchmarkSummaries, eq(benchmarkSummaries.benchmarkId, benchmarks.id))
        .where(eq(benchmarks.orgId, orgId))
        .groupBy(benchmarks.id)
        .orderBy(asc(benchmarks.addedAt), asc(benchmarks.id));
      return rows.map((row) => ({ ...benchmark(row.benchmark), runs: row.runs }));
    },
    async find(orgId: number, name: string): Promise<Benchmark | undefined> {
      const [row] = await db
        .select(columns)
        .from(benchmarks)
        .where(and(eq(benchmarks.orgId, orgId), eq(benchmarks.name, name)));
      return row ? benchmark(row) : undefined;
    },
    /** The tasks the benchmark had when added, as frozen then. */
    async tasks(id: number): Promise<FrozenTask[]> {
      const [row] = await db
        .select({ taskList: benchmarks.taskList })
        .from(benchmarks)
        .where(eq(benchmarks.id, id));
      return (row?.taskList as FrozenTask[] | undefined) ?? [];
    },
    /** Adds the dataset, or returns the org's benchmark of the same name unchanged. */
    async add(input: {
      orgId: number;
      name: string;
      ref: string;
      taskList: FrozenTask[];
      addedBy: number;
    }): Promise<{ benchmark: Benchmark; added: boolean }> {
      const [row] = await db
        .insert(benchmarks)
        .values({ ...input, tasks: input.taskList.length })
        .onConflictDoNothing()
        .returning(columns);
      if (row) return { benchmark: benchmark(row), added: true };
      const existing = await this.find(input.orgId, input.name);
      if (!existing) throw new Error("Benchmark could not be saved");
      return { benchmark: existing, added: false };
    },
    /** Removes the benchmark and its run summaries; its records stay in the bucket. */
    async remove(orgId: number, name: string): Promise<boolean> {
      const removed = await db
        .delete(benchmarks)
        .where(and(eq(benchmarks.orgId, orgId), eq(benchmarks.name, name)))
        .returning({ id: benchmarks.id });
      return removed.length > 0;
    },
  };
}
export type BenchmarkStore = ReturnType<typeof createBenchmarkStore>;
