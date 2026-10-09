import { afterAll, beforeAll, expect, test } from "bun:test";
import { evaluationPrefix, initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";

let server: Awaited<ReturnType<typeof evaluationServer>>;
beforeAll(async () => {
  server = await evaluationServer();
});
afterAll(async () => {
  await server.close();
});

test("evaluation routes require a session and current tenant membership", async () => {
  expect((await server.request(`${server.base}/options`, {}, null)).status).toBe(401);
  expect((await server.request(`${server.base}/options`, {}, 2)).status).toBe(404);
  expect((await server.request(`${server.base}/comparisons`, {}, 2)).status).toBe(404);
});

test("options expose only this repository's approved tasks", async () => {
  const response = await server.request(`${server.base}/options`);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    tasks: [{ runId: "run-one", taskId: "task-one", difficulty: "easy" }],
  });
  expect(text).not.toContain("bundleKey");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("runs start only through comparisons", async () => {
  const body = JSON.stringify({ id: crypto.randomUUID() });
  expect((await server.request(server.base, { method: "POST", body })).status).toBe(405);
  expect(server.starts).toHaveLength(0);
});

test("run and artifact lookup remain repository-scoped and reject arbitrary keys", async () => {
  const input = { ...evaluationInput(), repoId: server.repo.id };
  const run = initialEvaluation(input, input.modelName);
  run.trials[0]?.artifacts.push("0/solver/task/result.json");
  await server.artifacts.put(
    `${evaluationPrefix(server.repo.id, input.id)}artifacts/0/solver/task/result.json`,
    Buffer.from('{"reward":1}'),
    "text/plain",
  );
  await saveEvaluation(server.artifacts, run);
  const listed = await (await server.request(server.base)).json();
  expect(listed.runs.map((entry: { id: string }) => entry.id)).toContain(input.id);
  expect(listed.runs[0].trials[0].artifacts).toEqual([]);
  expect((await server.request(`${server.base}/${input.id}`)).status).toBe(200);
  expect(
    (await server.request(`${server.base}/${input.id}/artifacts?name=0/solver/task/result.json`))
      .status,
  ).toBe(200);
  expect(
    (await server.request(`${server.base}/${input.id}/artifacts?name=../../request.json`)).status,
  ).toBe(404);
  expect((await server.request(`${server.base}/${input.id}`, {}, 2)).status).toBe(404);
  const other = "/api/orgs/avyay/repos/avyay/other/evaluations";
  expect((await server.request(`${other}/${input.id}`)).status).toBe(404);
  expect(
    (await server.request(`${other}/${input.id}/artifacts?name=0/solver/task/result.json`)).status,
  ).toBe(404);
});

test("generation checks alone never admit tasks to the dataset", async () => {
  await server.tasks.upsertMany([
    {
      repoId: server.repo.id,
      runId: "run-pending",
      taskId: "pending-task",
      candidateId: "pending-task",
      difficulty: "easy",
      stage: "accepted",
      pipelineStatus: "accepted",
      bundleKey: "tasks/pending.tar.gz",
    },
  ]);
  const options = await (await server.request(`${server.base}/options`)).json();
  expect(options.tasks.some((task: { taskId: string }) => task.taskId === "pending-task")).toBe(
    false,
  );
});

test("failures are explained only for a repository GitHub confirms is still public", async () => {
  const explained = async (github?: { private: boolean }) => {
    const fixture = await evaluationServer(undefined, {}, undefined, github);
    try {
      const create = async (kind: string, value: string) => {
        const body = JSON.stringify({ name: kind, kind, value });
        const response = await fixture.request("/api/orgs/avyay/credentials", {
          method: "POST",
          body,
        });
        return (await response.json()).id as string;
      };
      const model = await create("openai", "sk-own-key-123456789");
      const draft = {
        id: crypto.randomUUID(),
        tasks: [{ runId: "run-one", taskId: "task-one" }],
        models: [{ catalogId: "gpt-6-sol", credentialId: model, harnesses: ["codex"] }],
        sandbox: "e2b",
        sandboxCredentialId: await create("e2b", "e2b-own-key"),
      };
      const body = JSON.stringify(draft);
      const response = await fixture.request(`${fixture.base}/comparisons`, {
        method: "POST",
        body,
      });
      expect(response.status).toBe(202);
      return fixture.starts[0]?.explainFailures;
    } finally {
      await fixture.close();
    }
  };
  expect(await explained({ private: false })).toBe(true);
  // Connected as public, but private on GitHub since: its code stays off SelfBench's account.
  expect(await explained({ private: true })).toBeUndefined();
  expect(await explained()).toBeUndefined();
});
