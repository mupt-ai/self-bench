import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { createBatchStore } from "../../src/db/batches.js";
import { createRepoStore } from "../../src/db/repos.js";
import { createRunStore } from "../../src/db/runs.js";
import { generationBatches, tasks as taskRows } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { createUserStore } from "../../src/db/users.js";
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

let shared: { database: Awaited<ReturnType<typeof testDatabase>>; repoId: number } | undefined;

/** The test run, attached to a connected repository so its candidates get task rows. */
async function connectedDatabase() {
  const database = await testDatabase();
  const users = createUserStore(database.db, { secret: "batch-activities-secret" });
  const user = await users.upsert({ githubId: 1, login: "o", token: "t", scopes: "", orgs: [] });
  const [org] = await users.orgsFor(user.id);
  if (!org) throw new Error("org missing");
  const repo = await createRepoStore(database.db).connect({
    orgId: org.id,
    githubId: 1,
    fullName: "o/r",
    defaultBranch: "main",
    private: false,
    connectedBy: user.id,
  });
  await createRunStore(database.db).attachRun(repo.id, run.runId, user.id);
  return { database, repoId: repo.id };
}

/** A fresh batch record; cases within a test share one database, one batch at a time. */
async function activitiesFor(state: Partial<GenerationBatch>) {
  if (!shared) {
    const connected = await connectedDatabase();
    shared = connected;
    cleanups.push(async () => {
      shared = undefined;
      await connected.database.close();
    });
  }
  const { database, repoId } = shared;
  await database.db.delete(generationBatches);
  await database.db.delete(taskRows);
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
  const tasks = createTaskStore(database.db);
  const activities = createBatchActivities({
    store,
    tasks,
    runs: createRunStore(database.db),
    artifacts: new LocalArtifactStore(directory),
    vault,
  });
  const read = async () => {
    const batch = await store.read(run.runId);
    if (!batch) throw new Error("batch missing");
    return batch;
  };
  return { activities, store, tasks, repoId, vault, read };
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

test("planning gives each candidate its task row; a stopped batch settles the rows still running", async () => {
  const two = { ...run, candidateCounts: { easy: 0, medium: 0, hard: 2 } };
  const f = await activitiesFor({ run: two, phase: "discovering", shards: [shard(0)] });
  await f.activities.recordBatchShard(run.runId, 0, {
    result: { report: artifact, candidates: [candidate("one", 1), candidate("two", 2)] },
  });
  await f.activities.planBatch(run.runId);
  // A retried plan inserts nothing twice.
  await f.activities.planBatch(run.runId);
  const planned = await f.tasks.listForRun(run.runId);
  expect(planned).toMatchObject([
    { candidateId: "one", pipelineStatus: "in_progress", stage: "queued", sourcePr: 1 },
    { candidateId: "two", pipelineStatus: "in_progress", stage: "queued", sourcePr: 2 },
  ]);
  expect(planned[0]?.workflowId).toBe(`${run.runId}/candidate/one`);
  await f.tasks.settle(run.runId, "one", { pipelineStatus: "rejected", stage: "authoring" });

  await f.activities.failBatch(run.runId, "worker lost");
  expect(await f.tasks.listForRun(run.runId)).toMatchObject([
    { candidateId: "one", pipelineStatus: "rejected" },
    { candidateId: "two", pipelineStatus: "infrastructure_failed", reason: "worker lost" },
  ]);
});
