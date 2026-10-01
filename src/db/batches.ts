import { eq } from "drizzle-orm";
import { type GenerationBatch, isFinished } from "../generation/batches/types.js";
import type { Database } from "./client.js";
import { generationBatches } from "./schema.js";

export function createBatchStore(db: Database) {
  return {
    async list() {
      return (await db.select().from(generationBatches)).map((row) => row.state);
    },
    async create(state: GenerationBatch): Promise<void> {
      await db.insert(generationBatches).values({ runId: state.run.runId, state });
    },
    async read(runId: string): Promise<GenerationBatch | undefined> {
      const [row] = await db
        .select()
        .from(generationBatches)
        .where(eq(generationBatches.runId, runId));
      return row?.state;
    },
    /**
     * Applies `change` to the batch under its row lock and returns the batch as it now stands. A
     * change that returns false or throws writes nothing.
     */
    async update(
      runId: string,
      change: (state: GenerationBatch) => boolean,
    ): Promise<GenerationBatch> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(eq(generationBatches.runId, runId))
          .for("update");
        if (!row) throw new Error(`batch ${runId} not found`);
        const state = structuredClone(row.state);
        if (!change(state)) return row.state;
        await tx
          .update(generationBatches)
          .set({ state, updatedAt: new Date() })
          .where(eq(generationBatches.runId, runId));
        return state;
      });
    },
    /**
     * Marks an unfinished batch as cancelling, so the page shows it before the workflow stops.
     * False when the batch already finished.
     */
    async cancel(runId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(eq(generationBatches.runId, runId))
          .for("update");
        if (row && isFinished(row.state.phase)) return false;
        if (!row) return true;
        await tx
          .update(generationBatches)
          .set({ state: { ...row.state, phase: "cancelling" }, updatedAt: new Date() })
          .where(eq(generationBatches.runId, runId));
        return true;
      });
    },
  };
}

export type BatchStore = ReturnType<typeof createBatchStore>;
