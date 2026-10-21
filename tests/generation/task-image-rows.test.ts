import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  provider: "modal" as const,
  agent: "im-agent",
  registry: { agent: `us-central1-docker.pkg.dev/p/selfbench-tasks/task-1@${digest}` },
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

test("saves only when the row still matches what was reconciled", async () => {
  const { db, rows, task } = await seeded();
  const { registry: _registry, ...unexported } = images;
  expect(
    await rows.save(
      { ...task, reviewDecision: "approve" },
      "runs/run-1/harbor-task.tar.gz",
      unexported,
    ),
  ).toBe(false);
  expect(await rows.save(task, "runs/run-1/harbor-task.tar.gz", unexported)).toBe(true);
  expect(await rows.save(task, "runs/run-1/harbor-task.tar.gz", unexported)).toBe(false);
  const saved = await rows.find(task.id);
  expect(saved?.bundleKey).toBe("runs/run-1/harbor-task.tar.gz");
  expect(saved?.images).toEqual(unexported);
  await db.update(tasks).set({ deletedAt: new Date() });
  const deleted = await rows.find(task.id);
  if (!deleted) throw new Error("deleted row is gone");
  expect(await rows.save(deleted, "runs/run-1/execution-task.tar.gz", images)).toBe(true);
});

test("an image is pinned while a comparison or release names its digest", async () => {
  const { db, rows, org, user } = await seeded();
  expect(await rows.referenced([digest])).toBe(false);
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
  expect(await rows.referenced([`sha256:${"c".repeat(64)}`, digest])).toBe(true);
  await db.delete(releases);
  await db.insert(comparisons).values({
    id: randomUUID(),
    orgId: org.id,
    repoId: 1,
    signature: "s",
    inputs: [{ tasks: [{ images }] }],
  });
  expect(await rows.referenced([digest])).toBe(true);
});
