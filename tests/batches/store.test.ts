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

test("dispatch planning sees every unfinished batch, oldest first, and commits its plan", async () => {
  const database = await testDatabase();
  try {
    const store = createBatchStore(database.db);
    for (const runId of ["first", "second"])
      await store.create({
        run: { ...run, runId },
        taskQueue: "test",
        phase: "authoring",
        shards: [],
        candidates: [],
      });
    await store.create({
      run: { ...run, runId: "done" },
      taskQueue: "test",
      phase: "complete",
      shards: [],
      candidates: [],
    });
    let seen: string[] = [];
    await store.plan((batches) => {
      seen = batches.map((batch) => batch.run.runId);
      for (const batch of batches) batch.error = "planned";
    });
    expect(seen).toEqual(["first", "second"]);
    expect((await store.read("second"))?.error).toBe("planned");
    expect((await store.read("done"))?.error).toBeUndefined();
  } finally {
    await database.close();
  }
});
