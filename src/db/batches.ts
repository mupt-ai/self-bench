import { and, eq, notInArray, sql } from "drizzle-orm";
import type { ArtifactRef } from "../contracts/index.js";
import { FINISHED_PHASES, type GenerationBatch, isFinished } from "../generation/batches/types.js";
import type { Database } from "./client.js";
import { generationBatches } from "./schema.js";

const unfinished = notInArray(sql`${generationBatches.state}->>'phase'`, [...FINISHED_PHASES]);

export function createBatchStore(db: Database) {
  return {
    async list() {
      return (await db.select().from(generationBatches)).map((row) => row.state);
    },
    async create(state: GenerationBatch): Promise<void> {
      await db.insert(generationBatches).values({ runId: state.run.runId, state });
    },
    async completeExport(runId: string, reference: ArtifactRef): Promise<void> {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(eq(generationBatches.runId, runId))
          .for("update");
        if (row?.state.phase !== "exporting") return;
        await tx
          .update(generationBatches)
          .set({
            state: { ...row.state, phase: "complete", export: reference },
            updatedAt: new Date(),
          })
          .where(eq(generationBatches.runId, runId));
      });
    },
    async read(runId: string): Promise<GenerationBatch | undefined> {
      const [row] = await db
        .select()
        .from(generationBatches)
        .where(eq(generationBatches.runId, runId));
      return row?.state;
    },
    /** Unfinished batches, least recently reconciled first. */
    async activeRunIds(): Promise<string[]> {
      const rows = await db
        .select({ runId: generationBatches.runId })
        .from(generationBatches)
        .where(unfinished)
        .orderBy(generationBatches.updatedAt);
      return rows.map((row) => row.runId);
    },
    /**
     * Applies `action` to one unfinished batch under its row lock, which serializes dispatch and
     * cancel across replicas. A throwing action commits nothing. False when the batch is
     * finished or another replica holds it.
     */
    async reconcile(
      runId: string,
      action: (state: GenerationBatch) => Promise<void>,
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(and(eq(generationBatches.runId, runId), unfinished))
          .for("update", { skipLocked: true });
        if (!row) return false;
        const state = structuredClone(row.state);
        await action(state);
        await tx
          .update(generationBatches)
          .set({ state, updatedAt: new Date() })
          .where(eq(generationBatches.runId, runId));
        return true;
      });
    },
    async cancel(runId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(eq(generationBatches.runId, runId))
          .for("update");
        if (!row) return false;
        if (isFinished(row.state.phase)) return true;
        await tx
          .update(generationBatches)
          .set({ state: { ...row.state, phase: "cancelling" }, updatedAt: new Date() })
          .where(eq(generationBatches.runId, runId));
        return true;
      });
    },
  };
}
