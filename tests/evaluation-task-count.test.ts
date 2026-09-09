import { expect, test } from "bun:test";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { MemoryRecords } from "./support/evaluation-records.js";

test("both evaluation endpoints accept eleven scoped approved tasks without truncation", async () => {
  const fixture = await evaluationServer(new MemoryRecords());
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const tasks = Array.from({ length: 11 }, (_, index) => ({
      runId: "large",
      taskId: `task-${index}`,
    }));
    await fixture.tasks.upsertMany(
      tasks.map((task) => ({
        ...task,
        repoId: fixture.repo.id,
        candidateId: task.taskId,
        pipelineStatus: "accepted",
        stage: "accepted",
        difficulty: "easy",
        bundleKey: `tasks/${task.taskId}.tar.gz`,
      })),
    );
    for (const task of tasks) {
      const row = await fixture.tasks.find(fixture.repo.id, task.runId, task.taskId);
      if (!row) throw new Error("Missing isolated task");
      await fixture.tasks.review(row.id, { decision: "approve", note: "Mock approval", userId: 1 });
    }
    const credential = async (kind: string) => {
      const response = await fixture.request(
        `${fixture.base}/credentials`,
        post({ name: kind, kind, value: "mock-only" }),
      );
      expect(response.status).toBe(201);
      return (await response.json()).id as string;
    };
    const modelKey = await credential("openai");
    const sandboxKey = await credential("e2b");
    const bodies = [
      {
        path: fixture.base,
        body: { model: "openai-test", harnesses: ["codex"], sandbox: "docker" },
      },
      {
        path: `${fixture.base}/comparisons`,
        body: {
          models: [{ catalogId: "openai-sol56", credentialId: modelKey, harnesses: ["codex"] }],
          sandbox: "e2b",
          sandboxCredentialId: sandboxKey,
        },
      },
    ];
    for (const { path, body } of bodies) {
      const selection = { ...body, id: crypto.randomUUID(), tasks };
      const count = fixture.starts.length;
      expect((await fixture.request(path, post(selection), 2)).status).toBe(404);
      for (const invalid of [[], [...tasks, { runId: "run-other", taskId: "task-other" }]]) {
        expect(
          (
            await fixture.request(
              path,
              post({ ...selection, id: crypto.randomUUID(), tasks: invalid }),
            )
          ).status,
        ).toBe(400);
      }
      expect(fixture.starts).toHaveLength(count);
      expect((await fixture.request(path, post(selection))).status).toBe(202);
      expect(fixture.starts).toHaveLength(count + 1);
      expect(fixture.starts.at(-1)?.tasks).toEqual(
        tasks.map((task) => ({ ...task, bundleKey: `tasks/${task.taskId}.tar.gz` })),
      );
    }
    const task = tasks[0];
    if (!task) throw new Error("Missing task");
    const row = await fixture.tasks.find(fixture.repo.id, task.runId, task.taskId);
    if (!row) throw new Error("Missing task row");
    await fixture.tasks.review(row.id, { decision: "reject", note: "Mock rejection", userId: 1 });
    const count = fixture.starts.length;
    for (const { path, body } of bodies) {
      expect(
        (await fixture.request(path, post({ ...body, id: crypto.randomUUID(), tasks }))).status,
      ).toBe(400);
    }
    expect(fixture.starts).toHaveLength(count);
  } finally {
    await fixture.close();
  }
});
