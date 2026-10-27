import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createRepoStore } from "../../src/db/repos.js";
import { evaluationRecords, tasks } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { createUserStore } from "../../src/db/users.js";
import { testAuthConfig, testDatabase } from "../support/site-fixture.js";
import { type SeededTask, seedTasks } from "../support/task-rows.js";

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
    const row = {
      repoId: repo.id,
      runId: "run-delete",
      candidateId: "candidate",
      taskId: "task",
      difficulty: "easy" as const,
      stage: "accepted",
      pipelineStatus: "accepted" as const,
      bundleKey: "historical-bundle",
      definition: { prompt: "Historical prompt" },
      workflowId: "historical-workflow",
    } satisfies SeededTask;
    await seedTasks(database.db, [row]);
    const task = await store.find(repo.id, row.runId, row.taskId);
    if (!task) throw new Error("Missing seeded task");
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
    await expect(
      store.review(task.id, {
        decision: "reject",
        note: "Stale verdict",
        userId: user.id,
      }),
    ).rejects.toThrow("task not found");
    await expect(store.clearReview(task.id)).rejects.toThrow("task not found");
    // Neither a plan nor a workflow's late writes bring a deleted task back.
    await store.plan([{ ...row, taskId: "renamed", stage: "queued", workflowId: "replanned" }]);
    expect(await store.progress(row.runId, row.candidateId, { stage: "authoring" })).toBe(false);
    expect(
      await store.settle(row.runId, row.candidateId, { pipelineStatus: "rejected", stage: "x" }),
    ).toBe(false);
    expect(await store.listForRepo(repo.id)).toEqual([]);
    expect(await store.find(repo.id, row.runId, row.taskId)).toBeUndefined();
    expect(await store.find(repo.id, row.runId, row.candidateId)).toBeUndefined();
    expect(await store.countsForRepos([repo.id])).toEqual([]);
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

    // A running task cannot be deleted until its workflow settles it.
    const active = { ...row, candidateId: "active", taskId: "active", workflowId: "active" };
    await store.plan([{ ...active, stage: "queued" }]);
    expect(await store.deleteTask(repo.id, active.runId, active.taskId)).toBe("active");
    await store.settle(active.runId, active.candidateId, {
      pipelineStatus: "accepted",
      stage: "accepted",
      bundleKey: "finished",
    });
    expect((await store.find(repo.id, active.runId, active.taskId))?.bundleKey).toBe("finished");
    expect(await store.deleteTask(repo.id, active.runId, active.taskId)).toBe("deleted");

    // A deletion racing the workflow's verdict leaves exactly one of them.
    const racing = { ...row, candidateId: "race", taskId: "race", workflowId: "race" };
    await store.plan([{ ...racing, stage: "queued" }]);
    await store.settle(racing.runId, racing.candidateId, {
      pipelineStatus: "rejected",
      stage: "authoring",
    });
    const [outcome, settledAgain] = await Promise.all([
      store.deleteTask(repo.id, racing.runId, racing.taskId),
      store.settle(racing.runId, racing.candidateId, {
        pipelineStatus: "accepted",
        stage: "accepted",
      }),
    ]);
    expect(outcome).toBe("deleted");
    expect(settledAgain).toBe(false);
    const [after] = await database.db.select().from(tasks).where(eq(tasks.candidateId, "race"));
    expect(after).toMatchObject({ pipelineStatus: "rejected" });
  } finally {
    await database.close();
  }
});
