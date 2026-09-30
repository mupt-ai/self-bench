import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { createBatchStore } from "../../src/db/batches.js";
import { createGenerationBatches } from "../../src/generation/batches/service.js";
import type { GenerationBatch } from "../../src/generation/batches/types.js";
import { testDatabase } from "../support/site-fixture.js";
import { candidate, run } from "../support/workflow-fixture.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A service over a real database and a Temporal client that knows one batch workflow. */
async function service(workflow: { status?: string; startError?: Error } = {}) {
  const database = await testDatabase();
  cleanups.push(() => database.close());
  const directory = await mkdtemp(join(tmpdir(), "batch-service-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const started: { type: unknown; options: Record<string, unknown> }[] = [];
  const cancelled: string[] = [];
  const missing = (workflowId: string) => new WorkflowNotFoundError("missing", workflowId, "");
  const client = {
    options: { namespace: "default" },
    connection: {
      withDeadline: async (_deadline: number, action: () => Promise<unknown>) => action(),
    },
    workflowService: {
      describeWorkflowExecution: async ({ execution }: { execution: { workflowId: string } }) => {
        throw missing(execution.workflowId);
      },
    },
    workflow: {
      start: async (type: unknown, options: Record<string, unknown>) => {
        started.push({ type, options });
        if (workflow.startError) throw workflow.startError;
      },
      getHandle: (workflowId: string) => ({
        describe: async () => {
          if (!workflow.status) throw missing(workflowId);
          return { status: { name: workflow.status } };
        },
        cancel: async () => {
          cancelled.push(workflowId);
          if (!workflow.status) throw missing(workflowId);
        },
      }),
    },
  } as unknown as Client;
  const store = createBatchStore(database.db);
  const batches = createGenerationBatches(
    database.db,
    client,
    new LocalArtifactStore(directory),
    "generation",
  );
  const create = (state: Partial<GenerationBatch>) =>
    store.create({
      run,
      taskQueue: "generation",
      phase: "authoring",
      shards: [],
      candidates: [{ workflowId: `${run.runId}/candidate/one`, candidate: candidate("one", 1) }],
      ...state,
    });
  return { batches, store, started, cancelled, create };
}

test("start records the batch, then starts its workflow under the run ID", async () => {
  const f = await service();
  await f.batches.start(run);
  expect(await f.store.read(run.runId)).toMatchObject({
    phase: "preparing",
    taskQueue: "generation",
  });
  expect(f.started).toHaveLength(1);
  expect(f.started[0]?.type).toMatchObject({ name: "selfBenchBatchWorkflow" });
  expect(f.started[0]?.options).toMatchObject({
    workflowId: run.runId,
    taskQueue: "generation",
    args: [run.runId],
    workflowIdReusePolicy: "REJECT_DUPLICATE",
  });
  await expect(f.batches.start(run)).rejects.toThrow("Batch ID already exists");

  // A start whose earlier response was lost finds the workflow already running.
  const retried = await service({
    startError: new WorkflowExecutionAlreadyStartedError("started", run.runId, "x"),
  });
  await retried.batches.start(run);
  expect((await retried.store.read(run.runId))?.phase).toBe("preparing");
});

test("cancel shows the cancel at once and cancels the workflow, even one that already closed", async () => {
  const f = await service({ status: "RUNNING" });
  await f.create({});
  await f.batches.cancel(run.runId);
  expect((await f.store.read(run.runId))?.phase).toBe("cancelling");
  expect(f.cancelled).toEqual([run.runId]);
  const closed = await service();
  await closed.create({ phase: "complete" });
  await closed.batches.cancel(run.runId);
  expect((await closed.store.read(run.runId))?.phase).toBe("complete");
});

test("a read settles a batch whose workflow closed or never started without recording an outcome", async () => {
  const running = await service({ status: "RUNNING" });
  await running.create({});
  expect((await running.batches.status(run.runId)).phase).toBe("authoring");

  const terminated = await service({ status: "TERMINATED" });
  await terminated.create({});
  expect(await terminated.batches.status(run.runId)).toMatchObject({
    phase: "failed",
    error: "Batch workflow terminated without recording an outcome.",
    tasks: [{ candidateId: "one", status: "infrastructure_failed" }],
  });

  const timedOut = await service({ status: "TIMED_OUT" });
  await timedOut.create({ phase: "cancelling" });
  expect((await timedOut.batches.status(run.runId)).phase).toBe("cancelled");

  const starting = await service();
  await starting.create({ phase: "preparing", acceptedAt: Date.now() });
  expect((await starting.batches.status(run.runId)).phase).toBe("preparing");

  const lost = await service();
  await lost.create({ phase: "preparing", acceptedAt: Date.now() - 10 * 60_000 });
  expect(await lost.batches.status(run.runId)).toMatchObject({
    phase: "failed",
    error: "Batch workflow never started. Start another batch.",
  });
});
