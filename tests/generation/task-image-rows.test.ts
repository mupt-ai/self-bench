import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { comparisons, orgs, releases, repos, tasks, users } from "../../src/db/schema.js";
import { taskImageRows } from "../../src/generation/tasks/task-images.js";
import { type TestDatabase, testDatabase } from "../support/test-database.js";

let database: TestDatabase | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

const digest = `sha256:${"b".repeat(64)}`;
const images = {
  agent: `us-central1-docker.pkg.dev/p/selfbench-tasks/run-1/c1/agent@${digest}`,
  verifier: `us-central1-docker.pkg.dev/p/selfbench-tasks/run-1/c1/verifier@sha256:${"e".repeat(64)}`,
};

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("insert returned no row");
  return row;
}

async function seeded() {
  database = await testDatabase();
  const { db } = database;
  const user = one(
    await db
      .insert(users)
      .values({ githubId: 1, login: "avyay", githubToken: "token" })
      .returning(),
  );
  const org = one(
    await db.insert(orgs).values({ githubId: 2, login: "mupt-ai", kind: "org" }).returning(),
  );
  const repo = one(
    await db
      .insert(repos)
      .values({
        orgId: org.id,
        githubId: 3,
        fullName: "mupt-ai/self-bench",
        defaultBranch: "main",
        connectedBy: user.id,
      })
      .returning(),
  );
  const task = one(
    await db
      .insert(tasks)
      .values({
        repoId: repo.id,
        runId: "run-1",
        candidateId: "c1",
        taskId: "task-1",
        difficulty: "medium",
        pipelineStatus: "accepted",
        stage: "accepted",
        bundleKey: "runs/run-1/execution-task.tar.gz",
        images,
        reviewDecision: "reject",
      })
      .returning(),
  );
  return { db, rows: taskImageRows(db), task, org, user };
}

test("a removal saves only when the row still matches what was reconciled", async () => {
  const { db, rows, task } = await seeded();
  const compiled = "runs/run-1/harbor-task.tar.gz";
  expect(await rows.save({ ...task, reviewDecision: "approve" }, compiled)).toBe(false);
  await db.update(tasks).set({ deletedAt: new Date() });
  expect(await rows.save(task, compiled)).toBe(false);
  const deleted = await rows.find(task.id);
  if (!deleted) throw new Error("deleted row is gone");
  expect(await rows.save(deleted, compiled)).toBe(true);
  expect(await rows.save(deleted, compiled)).toBe(false);
  const saved = await rows.find(task.id);
  expect(saved?.bundleKey).toBe(compiled);
  expect(saved?.images).toBeNull();
});

test("an image is pinned while a comparison or release names its digest", async () => {
  const { db, rows, org, user, task } = await seeded();
  expect(await rows.referenced([digest], task.id)).toBe(false);
  // Another row naming the digest pins it; the task's own row does not.
  await db.insert(tasks).values({
    repoId: task.repoId,
    runId: "run-2",
    candidateId: "c2",
    taskId: "task-1",
    difficulty: "medium",
    pipelineStatus: "accepted",
    stage: "accepted",
    images,
    reviewDecision: "approve",
  });
  expect(await rows.referenced([digest], task.id)).toBe(true);
  await db.delete(tasks).where(eq(tasks.runId, "run-2"));
  await db.insert(releases).values({
    id: randomUUID(),
    orgId: org.id,
    githubRepoId: 3,
    fullName: "mupt-ai/self-bench",
    publisherLogin: "mupt-ai",
    releasedBy: user.id,
    releasedByLogin: "avyay",
    hash: "h",
    payload: {},
    detail: { tasks: [{ images }] },
  });
  expect(await rows.referenced([`sha256:${"c".repeat(64)}`, digest], task.id)).toBe(true);
  await db.delete(releases);
  await db.insert(comparisons).values({
    id: randomUUID(),
    orgId: org.id,
    repoId: 1,
    signature: "s",
    inputs: [{ tasks: [{ images }] }],
  });
  expect(await rows.referenced([digest], task.id)).toBe(true);
});

test("only a rejected or deleted row no longer pins a shared digest", async () => {
  const { db, rows, task } = await seeded();
  const other = { ...task, runId: "run-2", candidateId: "c2" };
  const insert = (fields: { reviewDecision: "approve" | "reject" | null; deletedAt?: Date }) =>
    db.insert(tasks).values({
      repoId: task.repoId,
      runId: other.runId,
      candidateId: other.candidateId,
      taskId: "task-1",
      difficulty: "medium",
      pipelineStatus: "accepted",
      stage: "accepted",
      images,
      ...fields,
    });
  await insert({ reviewDecision: "reject" });
  expect(await rows.referenced([digest], task.id)).toBe(false);
  await db.delete(tasks).where(eq(tasks.runId, "run-2"));
  await insert({ reviewDecision: "approve", deletedAt: new Date() });
  expect(await rows.referenced([digest], task.id)).toBe(false);
  await db.delete(tasks).where(eq(tasks.runId, "run-2"));
  await insert({ reviewDecision: "approve" });
  expect(await rows.referenced([digest], task.id)).toBe(true);
  // A task nobody reviewed yet runs on its images too.
  await db.delete(tasks).where(eq(tasks.runId, "run-2"));
  await insert({ reviewDecision: null });
  expect(await rows.referenced([digest], task.id)).toBe(true);
});

test("kept accepted rows without images are the ones a backfill rebuilds", async () => {
  const { db, rows, task } = await seeded();
  const add = (candidateId: string, fields: Partial<typeof tasks.$inferInsert>) =>
    db.insert(tasks).values({
      repoId: task.repoId,
      runId: "run-3",
      candidateId,
      taskId: candidateId,
      difficulty: "medium",
      pipelineStatus: "accepted",
      stage: "accepted",
      bundleKey: `runs/run-3/${candidateId}/harbor-task.tar.gz`,
      ...fields,
    });
  await add("unreviewed", {});
  await add("approved", { reviewDecision: "approve" });
  await add("rejected", { reviewDecision: "reject" });
  await add("deleted", { deletedAt: new Date() });
  await add("failed", { pipelineStatus: "infrastructure_failed" });
  await add("built", { images });
  const found = await rows.withoutImages();
  const names = (
    await Promise.all(found.map(async (id) => (await rows.find(id))?.candidateId))
  ).sort();
  expect(names).toEqual(["approved", "unreviewed"]);
  expect(await rows.withoutImages([task.repoId + 1])).toEqual([]);
});
