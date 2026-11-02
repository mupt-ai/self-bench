import { expect, test } from "bun:test";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { runCommand } from "../src/lib/process.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";
import { fakeHarbor, publishedTask } from "./support/harbor-registry.js";

const hello = publishedTask("hello-world/hello-world", {}, "1".repeat(64));
const build = publishedTask("terminal-bench/build", {}, "2".repeat(64));

test("a benchmark picks tasks and audits them as a repository does", async () => {
  const harbor = fakeHarbor({ "terminal-bench/dataset@latest": [build, hello] }, runCommand);
  const fixture = await evaluationServer(memoryVault(), { registryCommand: harbor.command });
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const credential = async (kind: string) =>
      (
        await (
          await fixture.request(
            "/api/orgs/avyay/credentials",
            post({ name: kind, kind, value: "mock-only" }),
          )
        ).json()
      ).id as string;
    await fixture.request(fixture.benchmarks, post({ reference: "terminal-bench/dataset" }));
    const base = `${fixture.benchmarks}/terminal-bench/dataset/evaluations`;

    // The Run page's task list, as a repository's: here, the tasks frozen when it was added.
    const options = await (await fixture.request(`${base}/options`)).json();
    expect(options.tasks.map((task: { taskId: string }) => task.taskId)).toEqual([
      "hello-world/hello-world",
      "terminal-bench/build",
    ]);
    expect(options.judge).toEqual({ variables: [], required: [] });

    const modelCredential = await credential("openai");
    const selection = {
      models: [{ catalogId: "gpt-6-sol", credentialId: modelCredential, harnesses: ["codex"] }],
      sandbox: "e2b",
      sandboxCredentialId: await credential("e2b"),
    };
    // A task the benchmark lacks, or one picked twice, is refused.
    const [first, second] = options.tasks as { runId: string; taskId: string }[];
    if (!first || !second) throw new Error("Missing tasks");
    for (const tasks of [[{ runId: "run-one", taskId: "task-one" }], [second, second]])
      expect(
        (
          await fixture.request(
            `${base}/comparisons`,
            post({ ...selection, id: crypto.randomUUID(), tasks }),
          )
        ).status,
      ).toBe(400);
    // Picking some tasks, as Retry Errored Tasks does, runs only those.
    const picked = await fixture.request(
      `${base}/comparisons`,
      post({ ...selection, id: crypto.randomUUID(), tasks: [second] }),
    );
    expect(picked.status).toBe(202);
    const input = fixture.starts[0];
    if (!input?.benchmarkId) throw new Error("Benchmark did not start");
    expect(input.tasks.map((task) => task.taskId)).toEqual(["terminal-bench/build"]);

    // Audit Task reads the bundle frozen for the run that failed the task.
    const run = initialEvaluation(input, input.modelName);
    const [failed] = run.trials;
    if (!failed) throw new Error("Missing trial");
    Object.assign(failed, { status: "completed", rewards: { reward: 0 } });
    await saveEvaluation(fixture.artifacts, run);
    const task = { runId: failed.runId, taskId: failed.taskId };
    const state = await fixture.request(`${base}/audit?${new URLSearchParams(task)}`);
    expect(await state.json()).toEqual({ available: true, running: false });
    const audit = { credentialId: modelCredential, model: "gpt-6-sol" };
    expect((await fixture.request(`${base}/audit`, post({ ...task, audit }))).status).toBe(202);
    expect(fixture.audits).toEqual([
      {
        benchmarkId: input.benchmarkId,
        ...task,
        bundleKey: input.tasks[0]?.bundleKey ?? "",
        audit: { orgId: fixture.repo.orgId, ...audit },
      },
    ]);
  } finally {
    await fixture.close();
  }
});
