import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { orgs, repos, tasks, users } from "../../src/db/schema.js";
import type { Vault } from "../../src/db/vault.js";
import type { TaskImageBuilder } from "../../src/generation/images/builder.js";
import { taskImageWorkerActivities } from "../../src/generation/tasks/task-images-activity.js";
import { type TestDatabase, testDatabase } from "../support/test-database.js";

let database: TestDatabase | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

async function taskWithoutImages() {
  database = await testDatabase();
  const { db } = database;
  const [user] = await db
    .insert(users)
    .values({ githubId: 1, login: "avyay", githubToken: "token" })
    .returning();
  const [org] = await db
    .insert(orgs)
    .values({ githubId: 2, login: "mupt-ai", kind: "org" })
    .returning();
  if (!user || !org) throw new Error("seed failed");
  const [repo] = await db
    .insert(repos)
    .values({
      orgId: org.id,
      githubId: 3,
      fullName: "mupt-ai/self-bench",
      defaultBranch: "main",
      connectedBy: user.id,
    })
    .returning();
  if (!repo) throw new Error("seed failed");
  const [task] = await db
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
    })
    .returning();
  if (!task) throw new Error("seed failed");
  const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "task-image-worker-")));
  return { db, store, task };
}

test("a worker that cannot rebuild never asks for a rebuild", async () => {
  const { db, store, task } = await taskWithoutImages();
  const { taskImages, rebuilds } = taskImageWorkerActivities(db, store, undefined);
  expect(rebuilds).not.toHaveProperty("rebuildTaskImages");
  expect((await taskImages.reconcileTaskImages?.(task.id))?.status).not.toBe("unbuilt");
});

test("a worker that rebuilds registers the rebuild it asks for", async () => {
  const { db, store, task } = await taskWithoutImages();
  const { taskImages, rebuilds } = taskImageWorkerActivities(db, store, {
    vault: {} as Pick<Vault, "records" | "credentials">,
    builder: {} as TaskImageBuilder,
    repository: "localhost:5000/tasks",
    serving: { env: {} },
  });
  expect(rebuilds).toHaveProperty("rebuildTaskImages");
  expect((await taskImages.reconcileTaskImages?.(task.id))?.status).toBe("unbuilt");
});
