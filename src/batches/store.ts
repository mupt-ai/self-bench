import { eq, sql } from "drizzle-orm";
import type { ArtifactRef } from "../contracts/index.js";
import type { Database } from "../db/client.js";
import { generationBatches } from "../db/schema.js";
import type { GenerationBatch } from "./types.js";

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
    /** Short application-owned reconciliation. Row locks serialize dispatch/cancel across replicas. */
    async reconcile(action: (state: GenerationBatch) => Promise<void>): Promise<void> {
      let failure: unknown;
      let failed = false;
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(sql`${generationBatches.state}->>'phase' NOT IN ('complete','failed','cancelled')`)
          .orderBy(generationBatches.updatedAt)
          .limit(1)
          .for("update", { skipLocked: true });
        if (!row) return;
        const next = structuredClone(row.state);
        try {
          await action(next);
        } catch (error) {
          failure = error;
          failed = true;
        }
        await tx
          .update(generationBatches)
          .set({ state: failed ? row.state : next, updatedAt: new Date() })
          .where(eq(generationBatches.runId, row.runId));
      });
      if (failed) throw failure;
    },
    async cancel(runId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(eq(generationBatches.runId, runId))
          .for("update");
        if (!row) return false;
        if (!["complete", "failed", "cancelled"].includes(row.state.phase)) {
          await tx
            .update(generationBatches)
            .set({ state: { ...row.state, phase: "cancelling" }, updatedAt: new Date() })
            .where(eq(generationBatches.runId, runId));
        }
        return true;
      });
    },
  };
}
