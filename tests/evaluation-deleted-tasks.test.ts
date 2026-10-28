import { expect, test } from "bun:test";
import { createTaskStore } from "../src/db/tasks.js";
import { repositoryTasks } from "../src/evaluation/frozen-tasks.js";
import { getEvaluation, initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";
import { seedTasks } from "./support/task-rows.js";

test("deleting a task removes its trials from results and stale retries, not release history", async () => {
  const site = await evaluationServer();
  try {
    const tasks = createTaskStore(site.db);
    await seedTasks(site.db, [
      {
        repoId: site.repo.id,
        runId: "run-deleted",
        taskId: "bad-task",
        candidateId: "bad-task",
        difficulty: "easy",
        stage: "accepted",
        pipelineStatus: "accepted",
        bundleKey: "bad-bundle",
      },
    ]);
    const input = {
      ...evaluationInput(),
      repoId: site.repo.id,
      tasks: [
        { runId: "run-one", taskId: "task-one", bundleKey: "good-bundle" },
        { runId: "run-deleted", taskId: "bad-task", bundleKey: "bad-bundle" },
      ],
    };
    const run = initialEvaluation(input, input.modelName);
    run.status = "failed";
    for (const trial of run.trials)
      Object.assign(trial, { status: "failed", error: "Broken task" });
    await saveEvaluation(site.artifacts, run);
    const before = await site.request(site.base);
    const tag = before.headers.get("etag") ?? "";
    expect((await site.request(site.base, { headers: { "if-none-match": tag } })).status).toBe(304);
    expect(await tasks.deleteTask(site.repo.id, "run-deleted", "bad-task")).toBe("deleted");
    const after = await site.request(site.base, { headers: { "if-none-match": tag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(tag);
    const listed = (await after.json()).runs.find((entry: { id: string }) => entry.id === run.id);
    expect(listed.trials.every((trial: { taskId: string }) => trial.taskId === "task-one")).toBe(
      true,
    );
    expect(listed.trials.length).toBe(input.harnesses.length);
    expect(
      (await repositoryTasks(tasks, site.repo.id, input.tasks)).map((task) => task.taskId),
    ).toEqual(["task-one"]);
    await expect(
      repositoryTasks(tasks, site.repo.id, [{ runId: "run-deleted", taskId: "bad-task" }]),
    ).rejects.toThrow("No selected tasks remain");
    await expect(
      repositoryTasks(tasks, site.repo.id, [{ runId: "unknown", taskId: "unknown" }]),
    ).rejects.toThrow("human-approved");
    expect((await getEvaluation(site.artifacts, input, input.id))?.trials.length).toBe(
      run.trials.length,
    );
  } finally {
    await site.close();
  }
});
