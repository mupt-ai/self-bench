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
     * Applies `action` to every unfinished batch, oldest first, holding all their row locks, so
     * replicas never plan dispatch against the same free capacity.
     */
    async plan(action: (batches: GenerationBatch[]) => void): Promise<void> {
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(generationBatches)
          .where(unfinished)
          .orderBy(generationBatches.createdAt, generationBatches.runId)
          .for("update");
        const states = rows.map((row) => structuredClone(row.state));
        action(states);
        for (const [index, row] of rows.entries())
          await tx
            .update(generationBatches)
            .set({ state: states[index] ?? row.state })
            .where(eq(generationBatches.runId, row.runId));
      });
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
    /**
     * Claims a preparing batch no replica has claimed since `staleBefore` (epoch ms). The claim
     * commits before any GitHub I/O, so no row lock is held while preparing.
     */
    async claimPrepare(
      runId: string,
      now: number,
      staleBefore: number,
    ): Promise<(GenerationBatch & { prepareAttempt: number }) | undefined> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(eq(generationBatches.runId, runId))
          .for("update", { skipLocked: true });
        if (row?.state.phase !== "preparing") return undefined;
        if (row.state.prepareAttempt !== undefined && row.state.prepareAttempt > staleBefore)
          return undefined;
        const state = { ...row.state, prepareAttempt: now };
        await tx
          .update(generationBatches)
          .set({ state, updatedAt: new Date() })
          .where(eq(generationBatches.runId, runId));
        return state;
      });
    },
    /**
     * Records a preparation outcome only while `attempt` is still the batch's current claim; a
     * cancelled or taken-over batch keeps its state.
     */
    async completePrepare(
      runId: string,
      attempt: number,
      outcome: Pick<GenerationBatch, "shards"> | { error: string },
    ): Promise<void> {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(eq(generationBatches.runId, runId))
          .for("update");
        if (row?.state.phase !== "preparing" || row.state.prepareAttempt !== attempt) return;
        const state: GenerationBatch =
          "error" in outcome
            ? { ...row.state, phase: "failed", error: outcome.error }
            : { ...row.state, phase: "discovering", shards: outcome.shards };
        await tx
          .update(generationBatches)
          .set({ state, updatedAt: new Date() })
          .where(eq(generationBatches.runId, runId));
      });
    },
    /** Fails a preparing batch untouched since `staleBefore`: no replica can still prepare it. */
    async abandonPrepare(runId: string, staleBefore: number, error: string): Promise<void> {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(generationBatches)
          .where(eq(generationBatches.runId, runId))
          .for("update", { skipLocked: true });
        if (row?.state.phase !== "preparing") return;
        if ((row.state.prepareAttempt ?? row.state.acceptedAt ?? 0) > staleBefore) return;
        await tx
          .update(generationBatches)
          .set({ state: { ...row.state, phase: "failed", error }, updatedAt: new Date() })
          .where(eq(generationBatches.runId, runId));
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
