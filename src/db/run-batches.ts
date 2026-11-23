import { count, desc, eq } from "drizzle-orm";
import { type EvaluationScope, scopeOf } from "../evaluation/scope.js";
import { withBatchId } from "../evaluation/store.js";
import type { EvaluationInput } from "../evaluation/types.js";
import type { Database } from "./client.js";
import { runBatches } from "./schema.js";
import { scopeTables } from "./scope-tables.js";

/** A saved evaluation batch: the expanded per-model inputs the worker runs. */
export interface RunBatchRecord {
  id: string;
  orgId: number;
  /** The repository or benchmark whose evaluations it runs. */
  scope: EvaluationScope;
  createdAt: string;
  signature: string;
  inputs: EvaluationInput[];
}

export function createRunBatchStore(db: Database) {
  const record = (row: typeof runBatches.$inferSelect): RunBatchRecord => ({
    id: row.id,
    orgId: row.orgId,
    scope: scopeOf({
      ...(row.repoId === null ? {} : { repoId: row.repoId }),
      ...(row.benchmarkId === null ? {} : { benchmarkId: row.benchmarkId }),
      ...(row.groupId === null ? {} : { groupId: row.groupId }),
    }),
    createdAt: row.createdAt.toISOString(),
    signature: row.signature,
    inputs: (row.inputs as EvaluationInput[]).map(withBatchId),
  });
  const find = async (id: string): Promise<RunBatchRecord | undefined> => {
    const [row] = await db.select().from(runBatches).where(eq(runBatches.id, id));
    return row ? record(row) : undefined;
  };
  return {
    find,
    async listForScope(scope: EvaluationScope): Promise<RunBatchRecord[]> {
      const { batch, id } = scopeTables(scope);
      const rows = await db
        .select()
        .from(runBatches)
        .where(eq(batch, id))
        .orderBy(desc(runBatches.createdAt));
      return rows.map(record);
    },
    async listForOrg(orgId: number): Promise<RunBatchRecord[]> {
      return (await db.select().from(runBatches).where(eq(runBatches.orgId, orgId))).map(record);
    },
    async countForOrg(orgId: number): Promise<number> {
      const [total] = await db
        .select({ value: count() })
        .from(runBatches)
        .where(eq(runBatches.orgId, orgId));
      return total?.value ?? 0;
    },
    /** Inserts once; a concurrent insert of the same ID returns the stored record. */
    async insert(value: RunBatchRecord): Promise<RunBatchRecord> {
      const { scope, ...fields } = value;
      const { repoId = null, benchmarkId = null, groupId = null } = scopeOf(scope);
      const [row] = await db
        .insert(runBatches)
        .values({ ...fields, repoId, benchmarkId, groupId, createdAt: new Date(value.createdAt) })
        .onConflictDoNothing()
        .returning();
      if (row) return record(row);
      const existing = await find(value.id);
      if (!existing) throw new Error("Batch could not be saved");
      return existing;
    },
  };
}
export type RunBatchStore = ReturnType<typeof createRunBatchStore>;
