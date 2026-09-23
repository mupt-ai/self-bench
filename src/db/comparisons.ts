import { count, desc, eq } from "drizzle-orm";
import type { EvaluationInput } from "../evaluation/types.js";
import type { Database } from "./client.js";
import { comparisons } from "./schema.js";

/** A saved evaluation comparison: the expanded per-model inputs the worker runs. */
export interface ComparisonRecord {
  id: string;
  orgId: number;
  repoId: number;
  createdAt: string;
  signature: string;
  inputs: EvaluationInput[];
}

export function createComparisonStore(db: Database) {
  const record = (row: typeof comparisons.$inferSelect): ComparisonRecord => ({
    id: row.id,
    orgId: row.orgId,
    repoId: row.repoId,
    createdAt: row.createdAt.toISOString(),
    signature: row.signature,
    inputs: row.inputs as EvaluationInput[],
  });
  const find = async (id: string): Promise<ComparisonRecord | undefined> => {
    const [row] = await db.select().from(comparisons).where(eq(comparisons.id, id));
    return row ? record(row) : undefined;
  };
  return {
    find,
    async listForRepo(repoId: number): Promise<ComparisonRecord[]> {
      const rows = await db
        .select()
        .from(comparisons)
        .where(eq(comparisons.repoId, repoId))
        .orderBy(desc(comparisons.createdAt));
      return rows.map(record);
    },
    async listForOrg(orgId: number): Promise<ComparisonRecord[]> {
      return (await db.select().from(comparisons).where(eq(comparisons.orgId, orgId))).map(record);
    },
    async countForOrg(orgId: number): Promise<number> {
      const [total] = await db
        .select({ value: count() })
        .from(comparisons)
        .where(eq(comparisons.orgId, orgId));
      return total?.value ?? 0;
    },
    /** Inserts once; a concurrent insert of the same ID returns the stored record. */
    async insert(value: ComparisonRecord): Promise<ComparisonRecord> {
      const [row] = await db
        .insert(comparisons)
        .values({ ...value, createdAt: new Date(value.createdAt) })
        .onConflictDoNothing()
        .returning();
      if (row) return record(row);
      const existing = await find(value.id);
      if (!existing) throw new Error("Comparison could not be saved");
      return existing;
    },
  };
}
export type ComparisonStore = ReturnType<typeof createComparisonStore>;
