import { and, eq, sql } from "drizzle-orm";
import type { ArtifactRef } from "../contracts/index.js";
import type { GenerationBatch } from "../generation/batches/types.js";
import type { Database } from "./client.js";
import { generationBatches } from "./schema.js";

const ACTIVE = sql`${generationBatches.state}->>'phase' NOT IN ('complete','failed','cancelled')`;

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
        .where(ACTIVE)
        .orderBy(generationBatches.updatedAt);
      return rows.map((row) => row.runId);
    },
    /**
     * Short application-owned reconciliation of one unfinished batch. Row locks serialize
     * dispatch/cancel across replicas; a batch another replica holds is skipped (false).
     */
    async reconcile(
      runId: string,
      action: (state: GenerationBatch) => Promise<void>,
    ): Promise<boolean> {
      let failure: unknown;
      let failed = false;
      const found = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(and(eq(generationBatches.runId, runId), ACTIVE))
          .for("update", { skipLocked: true });
        if (!row) return false;
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
        return true;
      });
      if (failed) throw failure;
      return found;
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
