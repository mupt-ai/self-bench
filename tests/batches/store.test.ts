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
    await expect(
      restarted.reconcile(async (state) => {
        state.phase = "complete";
        throw new Error("lost connection");
      }),
    ).rejects.toThrow();
    expect((await restarted.read(run.runId))?.phase).toBe("discovering");
    await restarted.reconcile(async (state) => {
      state.phase = "exporting";
    });
    await restarted.cancel(run.runId);
    await restarted.completeExport(run.runId, artifact);
    expect((await restarted.read(run.runId))?.phase).toBe("cancelling");
    await restarted.reconcile(async (state) => {
      state.phase = "cancelled";
    });
    let called = false;
    await restarted.reconcile(async () => {
      called = true;
    });
    expect(called).toBe(false);
  } finally {
    await database.close();
  }
});
