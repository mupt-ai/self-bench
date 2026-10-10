import { afterAll, beforeAll, expect, test } from "bun:test";
import { evaluationPrefix, initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { evaluationEnv, evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

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

test("Explain Failure starts one explanation for a trial that failed its tests", async () => {
  const vault = memoryVault();
  const fixture = await evaluationServer(
    vault,
    {},
    {
      ...evaluationEnv,
      SELFBENCH_MANAGED_OFFERING: "true",
      SELFBENCH_MANAGED_OPENROUTER_API_KEY: "sk-or-platform",
    },
  );
  try {
    const input: EvaluationInput = {
      ...evaluationInput(),
      repoId: fixture.repo.id,
      harnesses: ["codex", "pi"],
      comparisonId: crypto.randomUUID(),
    };
    await vault.comparisons.insert({
      id: input.comparisonId ?? "",
      orgId: fixture.repo.orgId,
      repoId: fixture.repo.id,
      createdAt: input.createdAt,
      signature: "test",
      inputs: [input],
    });
    const run = initialEvaluation(input, input.modelName);
    run.status = "completed";
    const [codex, pi] = run.trials;
    if (!codex || !pi) throw new Error("Missing trials");
    Object.assign(codex, { status: "completed", rewards: { reward: 1 } });
    Object.assign(pi, { status: "completed", rewards: { reward: 0 } });
    await saveEvaluation(fixture.artifacts, run);
    const trial = (harness: string) => ({ runId: "run-one", taskId: "task-one", harness });
    const explain = (harness: string, user: number | null = 1) =>
      fixture.request(
        `${fixture.base}/${run.id}/explain`,
        { method: "POST", body: JSON.stringify(trial(harness)) },
        user,
      );
    const state = async (harness: string) => {
      const query = new URLSearchParams(trial(harness));
      return (await fixture.request(`${fixture.base}/${run.id}/explain?${query}`)).json();
    };
    expect(await state("pi")).toEqual({ available: true, running: false });
    expect(await state("codex")).toMatchObject({ available: false, running: false });
    expect((await explain("pi")).status).toBe(202);
    // The passing trial, an unknown one, and another tenant's request start nothing.
    expect((await explain("codex")).status).toBe(409);
    expect((await explain("terminus-2")).status).toBe(404);
    expect((await explain("pi", 2)).status).toBe(404);
    expect(fixture.explains).toEqual([
      { repoId: fixture.repo.id, id: run.id, index: 1, bundleKey: "tasks/task.tar.gz" },
    ]);
    // One already running is not started again; one that just ended without a result waits.
    fixture.setExplainState({ running: true });
    expect(await state("pi")).toEqual({ available: true, running: true });
    expect((await explain("pi")).status).toBe(202);
    fixture.setExplainState({ running: false, endedAt: Date.now() });
    expect(await state("pi")).toMatchObject({ available: false, running: false });
    expect((await explain("pi")).status).toBe(429);
    expect(fixture.explains).toHaveLength(1);
    // Explained since: the page holding the stale run is told to read it again.
    Object.assign(pi, { failureSummary: { text: "It reversed them.", model: "gpt-6-luna" } });
    await saveEvaluation(fixture.artifacts, run);
    expect(await state("pi")).toMatchObject({ available: false, explained: true });
  } finally {
    await fixture.close();
  }
});

test("Explain Failure needs managed models and the bundle the trial ran", async () => {
  const managed = {
    ...evaluationEnv,
    SELFBENCH_MANAGED_OFFERING: "true",
    SELFBENCH_MANAGED_OPENROUTER_API_KEY: "sk-or-platform",
  };
  for (const env of [evaluationEnv, managed]) {
    // A run whose comparison was never recorded, so its bundle is unknown.
    const fixture = await evaluationServer(undefined, {}, env);
    try {
      const input = { ...evaluationInput(), repoId: fixture.repo.id };
      const run = initialEvaluation(input, input.modelName);
      Object.assign(run.trials[0] ?? {}, { status: "completed", rewards: { reward: 0 } });
      await saveEvaluation(fixture.artifacts, run);
      const response = await fixture.request(`${fixture.base}/${run.id}/explain`, {
        method: "POST",
        body: JSON.stringify({ runId: "run-one", taskId: "task-one", harness: "codex" }),
      });
      expect(response.status).toBe(409);
      expect(fixture.explains).toEqual([]);
    } finally {
      await fixture.close();
    }
  }
});
