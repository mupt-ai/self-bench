import { expect, test } from "bun:test";
import { createBatchStore } from "../../src/db/batches.js";
import { testDatabase } from "../support/site-fixture.js";
import { artifact, run } from "../support/workflow-fixture.js";

test("batch plan survives a new store instance; aborted sweeps rollback; cancelled export cannot complete", async () => {
  const database = await testDatabase();
  try {
    const store = createBatchStore(database.db);
    await store.create({
      run,
      taskQueue: "test",
      phase: "discovering",
      shards: [],
      candidates: [],
    });
    const restarted = createBatchStore(database.db);
    expect((await restarted.read(run.runId))?.phase).toBe("discovering");
    expect(await restarted.activeRunIds()).toEqual([run.runId]);
    await expect(
      restarted.reconcile(run.runId, async (state) => {
        state.phase = "complete";
        throw new Error("lost connection");
      }),
    ).rejects.toThrow();
    expect((await restarted.read(run.runId))?.phase).toBe("discovering");
    await restarted.reconcile(run.runId, async (state) => {
      state.phase = "exporting";
    });
    await restarted.cancel(run.runId);
    await restarted.completeExport(run.runId, artifact);
    expect((await restarted.read(run.runId))?.phase).toBe("cancelling");
    await restarted.reconcile(run.runId, async (state) => {
      state.phase = "cancelled";
    });
    expect(await restarted.activeRunIds()).toEqual([]);
    let called = false;
    expect(
      await restarted.reconcile(run.runId, async () => {
        called = true;
      }),
    ).toBe(false);
    expect(called).toBe(false);
  } finally {
    await database.close();
  }
});
