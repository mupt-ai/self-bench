import { and, asc, count, eq, getTableColumns, lt, or } from "drizzle-orm";
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
  /** Whether a worker is still downloading and checking its tasks, or why it couldn't. */
  status: "adding" | "ready" | "failed";
  error?: string;
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
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
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
    /**
     * Starts adding the dataset: a new box, or a failed or stranded one tried again at `ref`. Returns the
     * org's benchmark of the same name, and whether a worker should now freeze its tasks.
     */
    async start(input: {
      orgId: number;
      name: string;
      ref: string;
      addedBy: number;
      /** A box still `adding` since before this instant has no worker, and may be restarted. */
      strandedBefore: Date;
    }): Promise<{ benchmark: Benchmark; started: boolean }> {
      const { strandedBefore: _, ...row_ } = input;
      const [row] = await db
        .insert(benchmarks)
        .values({ ...row_, tasks: 0, taskList: [], status: "adding" })
        .onConflictDoNothing()
        .returning(columns);
      if (row) return { benchmark: benchmark(row), started: true };
      const [retried] = await db
        .update(benchmarks)
        .set({ ref: input.ref, status: "adding", error: null, addedBy: input.addedBy })
        .where(
          and(
            eq(benchmarks.orgId, input.orgId),
            eq(benchmarks.name, input.name),
            or(
              eq(benchmarks.status, "failed"),
              and(eq(benchmarks.status, "adding"), lt(benchmarks.addedAt, input.strandedBefore)),
            ),
          ),
        )
        .returning(columns);
      if (retried) return { benchmark: benchmark(retried), started: true };
      const existing = await this.find(input.orgId, input.name);
      if (!existing) throw new Error("Benchmark could not be saved");
      return { benchmark: existing, started: false };
    },
    /** Its tasks, frozen by a worker; a box removed or settled meanwhile is left as it is. */
    async finish(id: number, taskList: FrozenTask[]): Promise<void> {
      await db
        .update(benchmarks)
        .set({ status: "ready", taskList, tasks: taskList.length, error: null })
        .where(and(eq(benchmarks.id, id), eq(benchmarks.status, "adding")));
    },
    /** Why its tasks couldn't be frozen, shown on its box. */
    async fail(id: number, error: string): Promise<void> {
      await db
        .update(benchmarks)
        .set({ status: "failed", error })
        .where(and(eq(benchmarks.id, id), eq(benchmarks.status, "adding")));
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
