import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { createBatchStore } from "../../src/db/batches.js";
import { generationBatches } from "../../src/db/schema.js";
import { createBatchActivities } from "../../src/generation/batches/activities.js";
import * as exporter from "../../src/generation/batches/export.js";
import * as preparer from "../../src/generation/batches/prepare.js";
import { batchStatus } from "../../src/generation/batches/status.js";
import type { GenerationBatch } from "../../src/generation/batches/types.js";
import { saveGenerationGitHubToken } from "../../src/generation/settings/credentials.js";
import { memoryVault } from "../support/evaluation-vault.js";
import { testDatabase } from "../support/site-fixture.js";
import { artifact, candidate, run } from "../support/workflow-fixture.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const shard = (index: number): GenerationBatch["shards"][number] => ({
  workflowId: `${run.runId}/discovery/${index}`,
  input: {
    run,
    wave: 0,
    shardIndex: index,
    shardCount: 2,
    partitioned: true,
    targetCounts: run.candidateCounts,
    excludedSourcePrs: [],
  },
});
const result = (id: string, status: "accepted" | "rejected", taskId = id) => ({
  progress: { candidateId: id, taskId, difficulty: "hard" as const, status },
  ...(status === "accepted"
    ? {
        task: {
          taskId,
          candidateId: id,
          definition: artifact,
          sourceBundle: artifact,
          bundle: artifact,
        },
      }
    : {}),
});

let shared: Awaited<ReturnType<typeof testDatabase>> | undefined;

/** A fresh batch record; cases within a test share one database, one batch at a time. */
async function activitiesFor(state: Partial<GenerationBatch>) {
  if (!shared) {
    const database = await testDatabase();
    shared = database;
    cleanups.push(async () => {
      shared = undefined;
      await database.close();
    });
  }
  const database = shared;
  await database.db.delete(generationBatches);
  const directory = await mkdtemp(join(tmpdir(), "batch-activities-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const vault = memoryVault();
  const store = createBatchStore(database.db);
  await store.create({
    run,
    taskQueue: "generation",
    phase: "preparing",
    shards: [],
    candidates: [],
    ...state,
  });
  const activities = createBatchActivities({
    store,
    artifacts: new LocalArtifactStore(directory),
    vault,
  });
  const read = async () => {
    const batch = await store.read(run.runId);
    if (!batch) throw new Error("batch missing");
    return batch;
  };
  return { activities, store, vault, read };
}

test("preparation reads the submitter's saved token once and records the shards", async () => {
  const f = await activitiesFor({});
  await saveGenerationGitHubToken(f.vault.records, run.runId, "submitter-token");
  const tokens: string[] = [];
  const prepare = spyOn(preparer, "prepareGenerationBatch").mockImplementation(async (options) => {
    tokens.push(options.token);
    return [shard(0), shard(1)];
  });
  cleanups.push(() => prepare.mockRestore());
  expect(await f.activities.prepareBatch(run.runId)).toEqual([shard(0), shard(1)]);
  // A retried activity returns the recorded shards without fetching again.
  expect(await f.activities.prepareBatch(run.runId)).toEqual([shard(0), shard(1)]);
  expect(tokens).toEqual(["submitter-token"]);
  expect((await f.read()).phase).toBe("discovering");
});

test("a batch cancelled before preparation ends cancelled without fetching", async () => {
  const f = await activitiesFor({ phase: "cancelling" });
  const prepare = spyOn(preparer, "prepareGenerationBatch");
  cleanups.push(() => prepare.mockRestore());
  expect(await f.activities.prepareBatch(run.runId)).toEqual([]);
  expect(prepare).not.toHaveBeenCalled();
  expect((await f.read()).phase).toBe("cancelled");
});

test("planning takes shards in turn, newest first, trims each tier, and fails an empty or ambiguous plan", async () => {
  const found = (...candidates: ReturnType<typeof candidate>[]) => ({
    report: artifact,
    candidates,
  });
  const three = { ...run, candidateCounts: { easy: 0, medium: 0, hard: 3 } };
  const f = await activitiesFor({ run: three, phase: "discovering", shards: [shard(0), shard(1)] });
  await f.activities.recordBatchShard(run.runId, 0, {
    result: found(candidate("one", 1), candidate("two", 2)),
  });
  // The newer window claims PR 1 first, and its third pick loses to the older window's second.
  await f.activities.recordBatchShard(run.runId, 1, {
    result: found(candidate("again", 1), candidate("three", 3), candidate("four", 4)),
  });
  const planned = await f.activities.planBatch(run.runId);
  expect(planned.map((item) => item.workflowId)).toEqual([
    `${run.runId}/candidate/again`,
    `${run.runId}/candidate/three`,
    `${run.runId}/candidate/two`,
  ]);
  expect(planned[0]?.input).toEqual({ run: three, candidate: candidate("again", 1) });
  expect((await f.read()).phase).toBe("authoring");
  expect(await f.activities.planBatch(run.runId)).toEqual(planned);

  const empty = await activitiesFor({ phase: "discovering", shards: [shard(0)] });
  await empty.activities.recordBatchShard(run.runId, 0, { error: "discovery sandbox died" });
  expect(await empty.activities.planBatch(run.runId)).toEqual([]);
  expect(await empty.read()).toMatchObject({
    phase: "failed",
    error: "Discovery returned no candidates",
  });

  const ambiguous = await activitiesFor({ phase: "discovering", shards: [shard(0), shard(1)] });
  await ambiguous.activities.recordBatchShard(run.runId, 0, { result: found(candidate("one", 1)) });
  await ambiguous.activities.recordBatchShard(run.runId, 1, { result: found(candidate("one", 2)) });
  expect(await ambiguous.activities.planBatch(run.runId)).toEqual([]);
  expect(await ambiguous.read()).toMatchObject({
    phase: "failed",
    error: "Duplicate candidate ID across discovery shards",
  });
});

test("candidate results settle once, a task ID goes to the first to finish, and the batch exports", async () => {
  const ids = ["one", "two", "three", "four"];
  const f = await activitiesFor({
    phase: "authoring",
    candidates: ids.map((id, index) => ({
      workflowId: `${run.runId}/candidate/${id}`,
      candidate: candidate(id, index + 1),
    })),
  });
  await f.activities.recordBatchCandidate(run.runId, 1, { result: result("two", "accepted", "t") });
  await f.activities.recordBatchCandidate(run.runId, 0, { result: result("one", "accepted", "t") });
  await f.activities.recordBatchCandidate(run.runId, 2, { result: result("other", "rejected") });
  await f.activities.recordBatchCandidate(run.runId, 3, { error: "sandbox quota" });
  await f.activities.recordBatchCandidate(run.runId, 3, { result: result("four", "rejected") });
  const exported: string[][] = [];
  const build = spyOn(exporter, "exportBatch").mockImplementation(async (batch) => {
    exported.push(batch.candidates.flatMap((item) => item.result?.task?.candidateId ?? []));
    return artifact;
  });
  cleanups.push(() => build.mockRestore());
  await f.activities.exportBatch(run.runId);
  expect(exported).toEqual([["two"]]);
  const batch = await f.read();
  expect(batch).toMatchObject({ phase: "complete", export: artifact });
  expect(batch.candidates.map((item) => item.error)).toEqual([
    "Another candidate already owns this task ID",
    undefined,
    "Candidate returned an inconsistent result",
    "sandbox quota",
  ]);
});

test("a cancel keeps finished work, and one that lands during export wins over the export", async () => {
  const f = await activitiesFor({
    phase: "authoring",
    candidates: ["done", "pending"].map((id, index) => ({
      workflowId: `${run.runId}/candidate/${id}`,
      candidate: candidate(id, index + 1),
    })),
  });
  await f.activities.recordBatchCandidate(run.runId, 0, { result: result("done", "accepted") });
  await f.store.cancel(run.runId);
  await f.activities.recordBatchCancelled(run.runId);
  expect(batchStatus(await f.read())).toMatchObject({
    phase: "cancelled",
    accepted: 1,
    tasks: [
      { candidateId: "done", status: "accepted" },
      { candidateId: "pending", status: "infrastructure_failed", reason: "Generation cancelled." },
    ],
  });

  // A step that fails after the cancel was marked, before the workflow saw it, still cancels.
  const failing = await activitiesFor({});
  await failing.store.cancel(run.runId);
  await failing.activities.failBatch(run.runId, "GitHub unavailable");
  expect(await failing.read()).toMatchObject({ phase: "cancelled" });
  expect((await failing.read()).error).toBeUndefined();

  const exporting = await activitiesFor({
    phase: "authoring",
    candidates: [
      {
        workflowId: `${run.runId}/candidate/one`,
        candidate: candidate("one", 1),
        result: result("one", "accepted"),
      },
    ],
  });
  const build = spyOn(exporter, "exportBatch").mockImplementation(async () => {
    await exporting.store.cancel(run.runId);
    return artifact;
  });
  cleanups.push(() => build.mockRestore());
  await exporting.activities.exportBatch(run.runId);
  expect(await exporting.read()).toMatchObject({ phase: "cancelled" });
  expect((await exporting.read()).export).toBeUndefined();
});
