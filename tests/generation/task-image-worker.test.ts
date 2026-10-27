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

async function seed(row: Partial<typeof tasks.$inferInsert> = {}) {
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
      ...row,
    })
    .returning();
  if (!task) throw new Error("seed failed");
  const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "task-image-worker-")));
  return { db, store, task };
}

test("a worker that cannot rebuild never asks for a rebuild", async () => {
  const { db, store, task } = await seed();
  const { taskImages, rebuilds } = taskImageWorkerActivities(
    db,
    store,
    "localhost:5000/tasks",
    undefined,
  );
  expect(rebuilds).not.toHaveProperty("rebuildTaskImages");
  expect((await taskImages.reconcileTaskImages?.(task.id))?.status).not.toBe("unbuilt");
});

test("a worker that rebuilds registers the rebuild it asks for", async () => {
  const { db, store, task } = await seed();
  const { taskImages, rebuilds } = taskImageWorkerActivities(db, store, "localhost:5000/tasks", {
    vault: {} as Pick<Vault, "records" | "credentials">,
    builder: {} as TaskImageBuilder,
    serving: { env: {} },
  });
  expect(rebuilds).toHaveProperty("rebuildTaskImages");
  expect((await taskImages.reconcileTaskImages?.(task.id))?.status).toBe("unbuilt");
});

test("a rejected task's local images leave its row without a call to Artifact Registry", async () => {
  const local = {
    agent: `localhost:5000/tasks/run-1/c1/agent@sha256:${"a".repeat(64)}`,
    verifier: `localhost:5000/tasks/run-1/c1/verifier@sha256:${"b".repeat(64)}`,
  };
  const { db, store, task } = await seed({ images: local, reviewDecision: "reject" });
  await store.put("runs/harbor-task.tar.gz", new Uint8Array([1]), "application/gzip");
  const { taskImages } = taskImageWorkerActivities(db, store, "localhost:5000/tasks", undefined);
  expect(await taskImages.reconcileTaskImages?.(task.id)).toEqual({
    status: "removed",
    bundleKey: "runs/harbor-task.tar.gz",
  });
});
