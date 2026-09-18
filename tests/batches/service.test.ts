import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@temporalio/client";
import { LocalArtifactStore } from "../../src/artifacts.js";
import { createGenerationBatches } from "../../src/batches/service.js";
import { createBatchStore } from "../../src/batches/store.js";
import { testDatabase } from "../support/site-fixture.js";
import { candidate, run } from "../support/workflow-fixture.js";

test("application resumes a persisted candidate plan and exports without a batch Temporal execution", async () => {
  const database = await testDatabase();
  const directory = await mkdtemp(join(tmpdir(), "batch-service-"));
  const artifacts = new LocalArtifactStore(directory);
  const id = `${run.runId}/candidate/one`;
  const observed: string[] = [];
  const client = {
    connection: {
      withDeadline: async (_deadline: number, action: () => Promise<unknown>) => action(),
    },
    workflow: {
      getHandle: (workflowId: string) => {
        observed.push(workflowId);
        return {
          describe: async () => ({
            type: "selfBenchAuthorWorkflow",
            runId: "execution",
            status: { name: "COMPLETED" },
          }),
          result: async () => ({
            progress: {
              candidateId: "one",
              taskId: "one",
              difficulty: "hard",
              status: "rejected",
              reason: "not reproducible",
            },
          }),
        };
      },
      start: async () => {
        throw Error("completed workflow must not restart");
      },
    },
  } as unknown as Client;
  const store = createBatchStore(database.db);
  await store.create({
    run,
    taskQueue: "generation",
    phase: "authoring",
    shards: [],
    candidates: [{ workflowId: id, dispatchAttempted: true, candidate: candidate("one", 1) }],
  });
  const service = createGenerationBatches(database.db, client, artifacts, "generation");
  try {
    const deadline = Date.now() + 5_000;
    while ((await store.read(run.runId))?.phase !== "complete" && Date.now() < deadline)
      await Bun.sleep(10);
    const status = await service.status(run.runId);
    expect(status.phase).toBe("complete");
    expect(status.rejected).toBe(1);
    expect(status.export).toBeDefined();
    if (!status.export) throw Error("missing export");
    expect((await artifacts.get(status.export)).length).toBeGreaterThan(0);
    expect(observed.every((value) => value === id)).toBe(true);
  } finally {
    await service.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
