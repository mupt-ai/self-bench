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
async function service() {
  const workflow: { status?: string; startError?: Error } = {};
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
  // Each case uses its own run ID, so one database serves the whole test.
  const create = (runId: string, state: Partial<GenerationBatch>) =>
    store.create({
      run: { ...run, runId },
      taskQueue: "generation",
      phase: "authoring",
      shards: [],
      candidates: [{ workflowId: `${runId}/candidate/one`, candidate: candidate("one", 1) }],
      ...state,
    });
  return { batches, store, started, cancelled, create, workflow };
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
  f.workflow.startError = new WorkflowExecutionAlreadyStartedError("started", "retried", "x");
  await f.batches.start({ ...run, runId: "retried" });
  expect((await f.store.read("retried"))?.phase).toBe("preparing");
});

test("cancel shows the cancel at once and cancels the workflow, but leaves a finished batch alone", async () => {
  const f = await service();
  f.workflow.status = "RUNNING";
  await f.create("running", {});
  await f.batches.cancel("running");
  expect((await f.store.read("running"))?.phase).toBe("cancelling");
  expect(f.cancelled).toEqual(["running"]);
  delete f.workflow.status;
  await f.create("closed", { phase: "complete" });
  await f.batches.cancel("closed");
  expect((await f.store.read("closed"))?.phase).toBe("complete");
  expect(f.cancelled).toEqual(["running"]);
});

test("a read settles a batch whose workflow closed or never started without recording an outcome", async () => {
  const f = await service();
  const status = async (runId: string, workflowStatus: string | undefined) => {
    if (workflowStatus) f.workflow.status = workflowStatus;
    else delete f.workflow.status;
    return f.batches.status(runId);
  };
  await f.create("running", {});
  expect((await status("running", "RUNNING")).phase).toBe("authoring");

  await f.create("terminated", {});
  expect(await status("terminated", "TERMINATED")).toMatchObject({
    phase: "failed",
    error: "Batch workflow terminated without recording an outcome.",
    tasks: [{ candidateId: "one", status: "infrastructure_failed" }],
  });

  await f.create("timed-out", { phase: "cancelling" });
  expect((await status("timed-out", "TIMED_OUT")).phase).toBe("cancelled");

  await f.create("starting", { phase: "preparing", acceptedAt: Date.now() });
  expect((await status("starting", undefined)).phase).toBe("preparing");

  await f.create("lost", { phase: "preparing", acceptedAt: Date.now() - 10 * 60_000 });
  expect(await status("lost", undefined)).toMatchObject({
    phase: "failed",
    error: "Batch workflow never started. Start another batch.",
  });
});
