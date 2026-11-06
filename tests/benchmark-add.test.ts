import { expect, test } from "bun:test";
import { benchmarks } from "../src/db/evaluation-schema.js";
import { addBenchmarkWith } from "../src/evaluation/benchmark-add.js";
import { runCommand } from "../src/lib/process.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";
import { fakeHarbor, harborTaskToml, publishedTask } from "./support/harbor-registry.js";

const hello = publishedTask("hello-world/hello-world", {}, "1".repeat(64));
const unsafe = publishedTask(
  "unsafe/leak",
  { "task.toml": `${harborTaskToml("unsafe/leak")}LEAK = "\${MODAL_TOKEN_SECRET}"\n` },
  "3".repeat(64),
);

test("a refused dataset fails its box with the reason, and adding it again tries again", async () => {
  const liveRegistry: Record<string, (typeof hello)[]> = {
    "attacker/dataset@latest": [hello, unsafe],
  };
  const harbor = fakeHarbor(liveRegistry, runCommand);
  const fixture = await evaluationServer(memoryVault(), { registryCommand: harbor.command });
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    // Adding checks every task once on a worker: a dataset a comparison would refuse fails its
    // box with the reason, runs on it are refused, and it can be removed.
    const refused = await fixture.request(
      fixture.benchmarks,
      post({ reference: "attacker/dataset" }),
    );
    expect(refused.status).toBe(202);
    const failedBox = (await (await fixture.request(fixture.benchmarks)).json()).benchmarks[0];
    expect(failedBox).toMatchObject({ name: "attacker/dataset", status: "failed", tasks: 0 });
    expect(failedBox.error).toContain("unsafe/leak: task bundle refused");
    expect(
      (await fixture.request(`${fixture.benchmarks}/attacker/dataset/evaluations/comparisons`))
        .status,
    ).toBe(409);
    // Adding a failed box again tries again; once the dataset is fixed, it is added.
    liveRegistry["attacker/dataset@latest"] = [hello];
    expect(
      (await fixture.request(fixture.benchmarks, post({ reference: "attacker/dataset" }))).status,
    ).toBe(202);
    expect((await (await fixture.request(fixture.benchmarks)).json()).benchmarks[0]).toMatchObject({
      name: "attacker/dataset",
      status: "ready",
      tasks: 1,
    });
    expect(
      (await fixture.request(`${fixture.benchmarks}/attacker/dataset`, { method: "DELETE" }))
        .status,
    ).toBe(200);
  } finally {
    await fixture.close();
  }
});

test("a failed freeze settles the box with the dataset's own reason, not Temporal's wrapper", async () => {
  const settled: unknown[] = [];
  // As an activity failure reaches a workflow: Temporal's message around the one thrown.
  const thrown = new Error("Activity task failed", {
    cause: new Error("unsafe/leak: task bundle refused: task.toml sets env"),
  });
  await addBenchmarkWith(
    {
      freezeBenchmarkTasks: async () => {
        throw thrown;
      },
      finishBenchmark: async (id, tasks) => {
        settled.push(["finish", id, tasks]);
      },
      failBenchmark: async (id, error) => {
        settled.push(["fail", id, error]);
      },
    },
    { id: 7, name: "attacker/dataset", ref: "latest" },
  );
  expect(settled).toEqual([["fail", 7, "unsafe/leak: task bundle refused: task.toml sets env"]]);
});

test("a box left adding with no worker running is added again once it is stale, not refused", async () => {
  const hello = publishedTask("hello-world/hello-world", {}, "1".repeat(64));
  const harbor = fakeHarbor({ "stranded/dataset@latest": [hello] }, runCommand);
  const fixture = await evaluationServer(memoryVault(), { registryCommand: harbor.command });
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    // A worker that died mid-add leaves its box `adding` with nothing to finish it.
    await fixture.db.insert(benchmarks).values({
      orgId: fixture.repo.orgId,
      name: "stranded/dataset",
      ref: "latest",
      tasks: 0,
      taskList: [],
      addedBy: fixture.user.id,
      status: "adding",
      addedAt: new Date(Date.now() - 60 * 60_000),
    });
    const again = await fixture.request(
      fixture.benchmarks,
      post({ reference: "stranded/dataset" }),
    );
    expect(again.status).toBe(202);
    expect((await (await fixture.request(fixture.benchmarks)).json()).benchmarks[0]).toMatchObject({
      name: "stranded/dataset",
      status: "ready",
      tasks: 1,
    });
  } finally {
    await fixture.close();
  }
});
