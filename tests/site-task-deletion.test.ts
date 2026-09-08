import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createUserStore } from "../src/auth/users.js";
import { evaluationRecords, tasks } from "../src/db/schema.js";
import { createRepoStore } from "../src/site/repo-store.js";
import { createTaskStore, type TaskUpsert } from "../src/site/task-store.js";
import { testAuthConfig, testDatabase } from "./support/site-fixture.js";

test("task tombstones retain history, exclude all public reads and cannot be overwritten", async () => {
  const database = await testDatabase();
  try {
    const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    const user = await users.upsert({
      githubId: 1,
      login: "owner",
      token: "test",
      scopes: "",
      orgs: [],
    });
    const org = (await users.orgsFor(user.id))[0];
    if (!org) throw new Error("Missing test organization");
    const repos = createRepoStore(database.db);
    const connect = (name: string, githubId: number) =>
      repos.connect({
        orgId: org.id,
        githubId,
        fullName: `owner/${name}`,
        defaultBranch: "main",
        private: true,
        connectedBy: user.id,
      });
    const repo = await connect("one", 1);
    const other = await connect("two", 2);
    const store = createTaskStore(database.db);
    const row: TaskUpsert = {
      repoId: repo.id,
      runId: "run-delete",
      candidateId: "candidate",
      taskId: "task",
      difficulty: "easy",
      stage: "accepted",
      pipelineStatus: "accepted",
      bundleKey: "historical-bundle",
      definition: { prompt: "Historical prompt" },
    };
    const task = await store.insertStarted({
      ...row,
      workflowId: "historical-workflow",
      startedBy: user.id,
    });
    await store.review(task.id, {
      decision: "approve",
      note: "Historical review",
      userId: user.id,
    });
    await database.db
      .insert(evaluationRecords)
      .values({ path: "comparisons/history", version: 1, sealed: "test-only-record" });

    expect(await store.deleteTask(other.id, row.runId, row.taskId)).toBe("missing");
    expect(await store.deleteTask(repo.id, row.runId, row.taskId)).toBe("deleted");
    expect(await store.deleteTask(repo.id, row.runId, row.taskId)).toBe("deleted");
    await store.upsertMany([
      { ...row, taskId: "renamed", pipelineStatus: "in_progress", stage: "authoring" },
    ]);
    await store.progress(task.id, { stage: "authoring", pipelineStatus: "in_progress" });
    expect(await store.listForRepo(repo.id)).toEqual([]);
    expect(await store.find(repo.id, row.runId, row.taskId)).toBeUndefined();
    expect(await store.find(repo.id, row.runId, row.candidateId)).toBeUndefined();
    expect(await store.inProgress(repo.id)).toEqual([]);
    expect(await store.countsForRepos([repo.id])).toEqual([]);
    await store.upsertMany([row]);
    const retained = (await database.db.select().from(tasks).where(eq(tasks.id, task.id)))[0];
    if (!retained) throw new Error("Deleted task history was lost");
    expect(retained.deletedAt).toBeInstanceOf(Date);
    expect(retained).toMatchObject({
      taskId: "task",
      pipelineStatus: "accepted",
      bundleKey: row.bundleKey,
      definition: row.definition,
      reviewNote: "Historical review",
    });
    expect(await database.db.select().from(evaluationRecords)).toEqual([
      { path: "comparisons/history", version: 1, sealed: "test-only-record" },
    ]);

    const active: TaskUpsert = {
      ...row,
      candidateId: "active",
      taskId: "active",
      pipelineStatus: "in_progress",
    };
    await store.upsertMany([active]);
    expect(await store.deleteTask(repo.id, active.runId, active.taskId)).toBe("active");
    const found = await store.find(repo.id, active.runId, active.taskId);
    if (!found) throw new Error("Missing active task");
    await store.upsertMany([{ ...active, repoId: other.id, taskId: "foreign-overwrite" }]);
    expect((await store.find(repo.id, active.runId, active.taskId))?.id).toBe(found.id);
    expect(await store.listForRepo(other.id)).toEqual([]);

    const workflowRow = { ...active, candidateId: "workflow", taskId: "workflow" };
    const workflow = await store.insertStarted({
      ...workflowRow,
      workflowId: "running-workflow",
      startedBy: user.id,
    });
    for (const pipelineStatus of ["accepted", "rejected"] as const) {
      await store.upsertMany([{ ...workflowRow, pipelineStatus }]);
      expect(await store.deleteTask(repo.id, workflowRow.runId, workflowRow.taskId)).toBe("active");
      expect((await store.inProgress(repo.id)).some((entry) => entry.id === workflow.id)).toBe(
        true,
      );
    }
    await store.progress(workflow.id, { pipelineStatus: "accepted", stage: "accepted" });
    await store.upsertMany([{ ...workflowRow, pipelineStatus: "accepted", bundleKey: "finished" }]);
    expect((await store.find(repo.id, workflowRow.runId, workflowRow.taskId))?.bundleKey).toBe(
      "finished",
    );
    expect(await store.deleteTask(repo.id, workflowRow.runId, workflowRow.taskId)).toBe("deleted");

    const racing = { ...row, candidateId: "race", taskId: "race" };
    await store.upsertMany([racing]);
    const [outcome] = await Promise.all([
      store.deleteTask(repo.id, racing.runId, racing.taskId),
      store.upsertMany([{ ...racing, pipelineStatus: "in_progress" }]),
    ]);
    const [after] = await database.db.select().from(tasks).where(eq(tasks.candidateId, "race"));
    expect(
      outcome === "deleted"
        ? after?.deletedAt !== null && after?.pipelineStatus === "accepted"
        : after?.deletedAt === null && after?.pipelineStatus === "in_progress",
    ).toBe(true);
  } finally {
    await database.close();
  }
});
