import { afterAll, beforeAll, expect, test } from "bun:test";
import { evaluationPrefix, getEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { evaluationServer } from "./support/evaluation-fixture.js";

let server: Awaited<ReturnType<typeof evaluationServer>>;
beforeAll(async () => {
  server = await evaluationServer();
});
afterAll(async () => {
  await server.close();
});
const selection = () => ({
  id: crypto.randomUUID(),
  model: "openai-test",
  harnesses: ["codex"],
  sandbox: "docker",
  tasks: [{ runId: "run-one", taskId: "task-one" }],
});
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

test("evaluation routes require a session and current tenant membership", async () => {
  expect((await server.request(`${server.base}/options`, {}, null)).status).toBe(401);
  expect((await server.request(`${server.base}/options`, {}, 2)).status).toBe(404);
  expect((await server.request(server.base, post(selection()), 2)).status).toBe(404);
  expect(server.starts).toHaveLength(0);
});
test("options expose only scoped runnable tasks and public configured choices", async () => {
  const response = await server.request(`${server.base}/options`);
  const text = await response.text();
  const options = JSON.parse(text);
  expect(options.tasks).toEqual([{ runId: "run-one", taskId: "task-one", difficulty: "easy" }]);
  expect(options.models[0].harnesses).toEqual(["codex", "pi"]);
  expect(text).not.toContain("credentialEnv");
  expect(text).not.toContain("SECRET");
  expect(text).not.toContain("bundleKey");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
test("cross-origin, tampered choices, duplicated and cross-repository tasks never start", async () => {
  expect(
    (
      await server.request(server.base, {
        ...post(selection()),
        headers: { origin: "https://evil.test" },
      })
    ).status,
  ).toBe(403);
  for (const body of [
    { ...selection(), model: "arbitrary/model" },
    { ...selection(), harnesses: ["oracle"] },
    { ...selection(), harnesses: ["claude-code"] },
    { ...selection(), harnesses: ["codex", "codex"] },
    { ...selection(), sandbox: "e2b" },
    { ...selection(), tasks: [] },
    {
      ...selection(),
      tasks: [
        { runId: "run-one", taskId: "task-one" },
        { runId: "run-one", taskId: "candidate-one" },
      ],
    },
    { ...selection(), tasks: Array(11).fill({ runId: "run-one", taskId: "task-one" }) },
    { ...selection(), tasks: [{ runId: "run-other", taskId: "task-other" }] },
    { ...selection(), credential: "browser-key" },
  ])
    expect((await server.request(server.base, post(body))).status).toBe(400);
  expect(server.starts).toHaveLength(0);
});
test("explicit Run snapshots selected bundle identities, with replay-safe request IDs", async () => {
  const body = selection();
  expect((await server.request(server.base, post(body))).status).toBe(202);
  const input = server.starts.at(-1);
  expect(input).toMatchObject({
    repoId: server.repo.id,
    tenant: "avyay",
    tasks: [{ runId: "run-one", taskId: "task-one", bundleKey: "tasks/task.tar.gz" }],
  });
  expect(JSON.stringify(input)).not.toContain("secret");
  const run = await getEvaluation(server.artifacts, server.repo.id, body.id);
  if (!run) throw new Error("Run missing");
  run.status = "completed";
  await saveEvaluation(server.artifacts, run);
  const count = server.starts.length;
  expect((await server.request(server.base, post(body))).status).toBe(202);
  expect(server.starts).toHaveLength(count);
  expect((await server.request(server.base, post({ ...body, harnesses: ["pi"] }))).status).toBe(
    409,
  );
});
test("unconfirmed workflow submission retries the same immutable request", async () => {
  const body = selection();
  server.failStart(true);
  expect((await server.request(server.base, post(body))).status).toBe(503);
  const saved = await getEvaluation(server.artifacts, server.repo.id, body.id);
  server.failStart(false);
  expect((await server.request(server.base, post(body))).status).toBe(202);
  expect(server.starts.at(-1)?.createdAt).toBe(saved?.createdAt);
  expect(server.starts.at(-1)?.id).toBe(body.id);
});
test("run and artifact lookup remain repository-scoped and reject arbitrary keys", async () => {
  const body = selection();
  await server.request(server.base, post(body));
  const run = await getEvaluation(server.artifacts, server.repo.id, body.id);
  if (!run?.trials[0]) throw new Error("No trial");
  run.trials[0].artifacts.push("0/solver/task/result.json");
  await server.artifacts.put(
    `${evaluationPrefix(server.repo.id, body.id)}artifacts/0/solver/task/result.json`,
    Buffer.from('{"reward":1}'),
    "text/plain",
  );
  await saveEvaluation(server.artifacts, run);
  expect(
    (await server.request(`${server.base}/${body.id}/artifacts?name=0/solver/task/result.json`))
      .status,
  ).toBe(200);
  expect(
    (await server.request(`${server.base}/${body.id}/artifacts?name=../../request.json`)).status,
  ).toBe(404);
  expect((await server.request(`${server.base}/${body.id}`, {}, 2)).status).toBe(404);
  expect(
    (await server.request(`/api/orgs/avyay/repos/avyay/other/evaluations/${body.id}`)).status,
  ).toBe(404);
  expect(
    (
      await server.request(
        `/api/orgs/avyay/repos/avyay/other/evaluations/${body.id}/artifacts?name=0/solver/task/result.json`,
      )
    ).status,
  ).toBe(404);
});
test("an interrupted initial snapshot write recovers the original submission identity", async () => {
  const body = selection();
  const original = {
    ...body,
    modelName: "openai/test-model",
    repoId: server.repo.id,
    tenant: "avyay",
    startedBy: "avyay",
    createdAt: "2026-09-01T00:00:00Z",
    tasks: [{ runId: "run-one", taskId: "task-one", bundleKey: "tasks/task.tar.gz" }],
  };
  await server.artifacts.put(
    `${evaluationPrefix(server.repo.id, body.id)}request.json`,
    Buffer.from(JSON.stringify(original)),
    "application/json",
  );
  expect((await server.request(server.base, post(body))).status).toBe(202);
  expect(server.starts.at(-1)?.createdAt).toBe(original.createdAt);
});
test("generation checks alone never admit tasks to the dataset or solver", async () => {
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
  const count = server.starts.length;
  expect(
    (
      await server.request(
        server.base,
        post({ ...selection(), tasks: [{ runId: "run-pending", taskId: "pending-task" }] }),
      )
    ).status,
  ).toBe(400);
  expect(server.starts.length).toBe(count);
});
