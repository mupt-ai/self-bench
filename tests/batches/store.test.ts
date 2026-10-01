import { expect, test } from "bun:test";
import { createBatchStore } from "../../src/db/batches.js";
import { testDatabase } from "../support/site-fixture.js";
import { run } from "../support/workflow-fixture.js";

test("a failed change writes nothing, and a cancel never reopens a finished batch", async () => {
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
    await expect(
      store.update(run.runId, (state) => {
        state.phase = "complete";
        throw new Error("lost connection");
      }),
    ).rejects.toThrow("lost connection");
    expect((await createBatchStore(database.db).read(run.runId))?.phase).toBe("discovering");
    await store.cancel(run.runId);
    expect((await store.read(run.runId))?.phase).toBe("cancelling");
    await store.update(run.runId, (state) => {
      state.phase = "cancelled";
      return true;
    });
    await store.cancel(run.runId);
    expect((await store.read(run.runId))?.phase).toBe("cancelled");
    await expect(store.update("missing", () => true)).rejects.toThrow("batch missing not found");
  } finally {
    await database.close();
  }
});
