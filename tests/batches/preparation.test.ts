import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, WorkflowNotFoundError } from "@temporalio/client";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { createBatchStore } from "../../src/db/batches.js";
import * as preparer from "../../src/generation/batches/prepare.js";
import { createGenerationBatches } from "../../src/generation/batches/service.js";
import type { GenerationBatch } from "../../src/generation/batches/types.js";
import { testDatabase } from "../support/site-fixture.js";
import { run } from "../support/workflow-fixture.js";

/** A service whose GitHub preparation resolves only when the test says so. */
async function preparingService() {
  const database = await testDatabase();
  const directory = await mkdtemp(join(tmpdir(), "batch-service-"));
  const artifacts = new LocalArtifactStore(directory);
  const started = new Set<string>();
  const client = {
    connection: {
      withDeadline: async (_deadline: number, action: () => Promise<unknown>) => action(),
    },
    workflow: {
      getHandle: (workflowId: string) => ({
        describe: async () => {
          if (!started.has(workflowId)) throw new WorkflowNotFoundError("missing", workflowId, "");
          return {
            type: "selfBenchDiscoveryShardWorkflow",
            runId: "execution",
            status: { name: "RUNNING" },
          };
        },
      }),
      start: async (_type: string, options: { workflowId: string }) => {
        started.add(options.workflowId);
      },
    },
  } as unknown as Client;
  const prepared = Promise.withResolvers<GenerationBatch>();
  const tokens: string[] = [];
  const prepare = spyOn(preparer, "prepareGenerationBatch").mockImplementation(async (options) => {
    tokens.push(options.token);
    return prepared.promise;
  });
  const store = createBatchStore(database.db);
  const service = createGenerationBatches(database.db, client, artifacts, "generation");
  const until = async (done: () => Promise<boolean>) => {
    const deadline = Date.now() + 8_000;
    while (!(await done()) && Date.now() < deadline) await Bun.sleep(10);
  };
  const shard = {
    workflowId: `${run.runId}/discovery/0`,
    input: {
      run,
      partitioned: true,
      wave: 0,
      shardIndex: 0,
      shardCount: 1,
      targetCounts: run.candidateCounts,
      excludedSourcePrs: [],
    },
  };
  return {
    db: database.db,
    service,
    store,
    started,
    tokens,
    prepared,
    until,
    discovering: {
      run,
      taskQueue: "generation",
      phase: "discovering",
      shards: [shard],
      candidates: [],
    } as GenerationBatch,
    async close() {
      await service.close();
      prepare.mockRestore();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("start returns before the merged-PR fetch, which the sweep then turns into discovery", async () => {
  const f = await preparingService();
  try {
    const start = f.service.start(run, "submitter-token").then(() => "returned");
    expect(await Promise.race([start, Bun.sleep(1_000).then(() => "blocked")])).toBe("returned");
    expect((await f.service.status(run.runId)).phase).toBe("preparing");
    f.prepared.resolve(f.discovering);
    await f.until(async () => f.started.has(`${run.runId}/discovery/0`));
    expect(f.started).toEqual(new Set([`${run.runId}/discovery/0`]));
    expect(f.tokens).toEqual(["submitter-token"]);
    expect((await f.store.read(run.runId))?.phase).toBe("discovering");
  } finally {
    await f.close();
  }
}, 12_000);

test("a failed preparation fails the batch with its reason", async () => {
  const f = await preparingService();
  try {
    await f.service.start(run, "submitter-token");
    f.prepared.reject(new Error("No eligible merged PRs found"));
    await f.until(async () => (await f.store.read(run.runId))?.phase === "failed");
    const status = await f.service.status(run.runId);
    expect(status.phase).toBe("failed");
    expect(status.error).toBe("No eligible merged PRs found");
  } finally {
    await f.close();
  }
}, 12_000);

test("a batch cancelled while preparing never starts discovery", async () => {
  const f = await preparingService();
  try {
    await f.service.start(run, "submitter-token");
    await f.service.cancel(run.runId);
    await f.until(async () => (await f.store.read(run.runId))?.phase === "cancelled");
    f.prepared.resolve(f.discovering);
    await f.service.close();
    expect((await f.store.read(run.runId))?.phase).toBe("cancelled");
    expect(f.started.size).toBe(0);
  } finally {
    await f.close();
  }
}, 12_000);

test("a preparation whose result fails to save retries the save without refetching", async () => {
  const f = await preparingService();
  try {
    await f.service.start(run, "submitter-token");
    const transaction = f.db.transaction.bind(f.db);
    let failed = false;
    const save = spyOn(f.db, "transaction").mockImplementation(((
      ...args: Parameters<typeof transaction>
    ) => {
      if (failed) return transaction(...args);
      failed = true;
      return Promise.reject(new Error("database unavailable"));
    }) as typeof transaction);
    f.prepared.resolve(f.discovering);
    await f.until(async () => (await f.store.read(run.runId))?.phase === "discovering");
    save.mockRestore();
    expect((await f.store.read(run.runId))?.phase).toBe("discovering");
    expect(f.tokens).toEqual(["submitter-token"]);
  } finally {
    await f.close();
  }
}, 12_000);
