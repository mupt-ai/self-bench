import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { trialTimeouts } from "../src/contracts/agent-limit.js";
import { freezeRegistryTasks } from "../src/evaluation/frozen-tasks.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { unpackTrialTask } from "../src/evaluation/task-bundle.js";
import { prepareHarborRun } from "../src/harnesses/harbor/task-safety.js";
import { runCommand } from "../src/lib/process.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";
import { fakeHarbor, harborTaskToml, publishedTask } from "./support/harbor-registry.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-registry-"));
  directories.push(directory);
  return directory;
}

const hello = publishedTask("hello-world/hello-world", {}, "1".repeat(64));
const build = publishedTask(
  "terminal-bench/build",
  { "task.toml": harborTaskToml("terminal-bench/build", 'docker_image = "someone/build:1"\n') },
  "2".repeat(64),
);
const unsafe = publishedTask(
  "unsafe/leak",
  { "task.toml": `${harborTaskToml("unsafe/leak")}LEAK = "\${MODAL_TOKEN_SECRET}"\n` },
  "3".repeat(64),
);
const registry = {
  "terminal-bench/dataset@latest": [build, hello],
  "hello-world/hello-world@latest": [hello],
  "attacker/dataset@latest": [hello, unsafe],
};

test("registry tasks freeze once each, unchanged, into bundles a trial runs exactly as published", async () => {
  const store = new LocalArtifactStore(await temporary());
  const harbor = fakeHarbor(registry, runCommand);
  const tasks = await freezeRegistryTasks(
    store,
    ["terminal-bench/dataset", "hello-world/hello-world@latest"],
    { PATH: process.env.PATH },
    harbor.command,
  );
  expect(tasks.map(({ bundleKey: _, ...task }) => task)).toEqual([
    {
      runId: `harbor:sha256:${"1".repeat(64)}`,
      taskId: "hello-world/hello-world",
      registry: `hello-world/hello-world@sha256:${"1".repeat(64)}`,
      // Its own build, agent, and verifier limits: 600 + 120 + 120 seconds.
      minutes: 14,
    },
    {
      runId: `harbor:sha256:${"2".repeat(64)}`,
      taskId: "terminal-bench/build",
      registry: `terminal-bench/build@sha256:${"2".repeat(64)}`,
      minutes: 14,
    },
  ]);
  const task = tasks[1];
  if (!task) throw new Error("Missing task");
  expect(task.bundleKey).toMatch(/^harbor-registry\/terminal-bench\/build\/[a-f0-9]{64}\.tar\.gz$/);

  // A trial unpacks the bundle and passes the same check with a worker's environment, and
  // Harbor reads every file byte for byte as published: its image, network, and limits included.
  const trialRoot = await temporary();
  const taskPath = await unpackTrialTask(store, task, "docker", trialRoot, {});
  expect(taskPath).toBe(join(trialRoot, "task", "harbor-task"));
  const worker = { PATH: "/usr/bin", MODAL_TOKEN_SECRET: "as-secret" };
  await prepareHarborRun(taskPath, trialRoot, worker, undefined, 600, { published: true });
  for (const [path, text] of Object.entries(build.files))
    expect(await readFile(join(taskPath, path), "utf8")).toBe(text);
  // The `harbor run` around it is bounded by those limits, not a repository's agent time.
  expect(trialTimeouts(undefined, task.minutes).harborMs).toBe((14 + 30) * 60_000);
});

test("an unsafe task in a registry dataset refuses the whole dataset, and nothing is stored", async () => {
  const root = await temporary();
  const store = new LocalArtifactStore(root);
  const harbor = fakeHarbor(registry, runCommand);
  await expect(
    freezeRegistryTasks(store, ["attacker/dataset"], {}, harbor.command),
  ).rejects.toThrow(
    "unsafe/leak: task bundle refused: task.toml reads the host variable MODAL_TOKEN_SECRET",
  );
  expect(await store.list("harbor-registry")).toEqual([]);
});

test("an org adds registry datasets as benchmarks and runs each apart from its repositories", async () => {
  const harbor = fakeHarbor(registry, runCommand);
  const fixture = await evaluationServer(memoryVault(), { registryCommand: harbor.command });
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const credential = async (kind: string) => {
      const response = await fixture.request(
        "/api/orgs/avyay/credentials",
        post({ name: kind, kind, value: "mock-only" }),
      );
      expect(response.status).toBe(201);
      return (await response.json()).id as string;
    };
    // Adding checks every task once: a dataset a comparison would refuse is refused here.
    const refused = await fixture.request(
      fixture.benchmarks,
      post({ reference: "attacker/dataset" }),
    );
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("unsafe/leak: task bundle refused");
    expect((await fixture.request(fixture.benchmarks, post({ reference: "--help" }))).status).toBe(
      400,
    );
    const added = await fixture.request(
      fixture.benchmarks,
      post({ reference: "terminal-bench/dataset" }),
    );
    expect(added.status).toBe(201);
    expect((await added.json()).benchmark).toMatchObject({
      name: "terminal-bench/dataset",
      ref: "latest",
      tasks: 2,
    });
    expect(
      (
        await fixture.request(
          fixture.benchmarks,
          post({ reference: "terminal-bench/dataset@latest" }),
        )
      ).status,
    ).toBe(200);
    // The Dataset tab lists what was frozen, and each task page reads that task's checked files.
    const item = `${fixture.benchmarks}/terminal-bench/dataset`;
    const listedTasks = (await (await fixture.request(`${item}/tasks`)).json()).tasks;
    expect(listedTasks.map((task: { taskId: string }) => task.taskId)).toEqual([
      "hello-world/hello-world",
      "terminal-bench/build",
    ]);
    const files = await (
      await fixture.request(`${item}/task-files?task=${encodeURIComponent("terminal-bench/build")}`)
    ).json();
    expect(files.files.map((file: { path: string }) => file.path)).toContain("task.toml");
    // Exactly the published task.toml, prebuilt image and all.
    expect(files.files.find((file: { path: string }) => file.path === "task.toml").text).toBe(
      build.files["task.toml"],
    );
    expect((await fixture.request(`${item}/task-files?task=other/task`)).status).toBe(404);
    expect((await fixture.request(`${item}/tasks`, { method: "DELETE" })).status).toBe(405);
    await fixture.request(fixture.benchmarks, post({ reference: "hello-world/hello-world" }));
    const boxes = (await (await fixture.request(fixture.benchmarks)).json()).benchmarks;
    expect(boxes.map((box: { name: string; runs: number }) => [box.name, box.runs])).toEqual([
      ["terminal-bench/dataset", 0],
      ["hello-world/hello-world", 0],
    ]);
    expect((await fixture.request(fixture.benchmarks, {}, 2)).status).toBe(404);

    const base = `${fixture.benchmarks}/terminal-bench/dataset/evaluations`;
    const selection = {
      models: [
        { catalogId: "gpt-6-sol", credentialId: await credential("openai"), harnesses: ["codex"] },
      ],
      sandbox: "e2b",
      sandboxCredentialId: await credential("e2b"),
    };
    // A benchmark's comparison runs its own dataset; a repository's runs only its own tasks.
    for (const [path, invalid] of [
      [`${base}/comparisons`, { registry: ["hello-world/hello-world"] }],
      [`${base}/comparisons`, { tasks: [{ runId: "run-one", taskId: "task-one" }] }],
      [`${fixture.base}/comparisons`, { tasks: [], registry: ["hello-world/hello-world"] }],
    ] as const)
      expect(
        (await fixture.request(path, post({ ...selection, id: crypto.randomUUID(), ...invalid })))
          .status,
      ).toBe(400);
    expect(fixture.starts).toHaveLength(0);

    const id = crypto.randomUUID();
    const accepted = await fixture.request(`${base}/comparisons`, post({ ...selection, id }));
    expect(accepted.status).toBe(202);
    const input = fixture.starts[0];
    if (!input?.benchmarkId) throw new Error("Benchmark did not start");
    expect(input.tasks.map((task) => task.taskId)).toEqual([
      "hello-world/hello-world",
      "terminal-bench/build",
    ]);
    expect(input.repoId).toBeUndefined();
    // No agent time is imposed: the tasks keep their own limits, which bound each run.
    expect(input.agentMinutes).toBeUndefined();
    expect(input.taskMinutes).toBe(14);
    expect(await fixture.artifacts.stat(input.tasks[0]?.bundleKey ?? "")).toBeDefined();
    await saveEvaluation(fixture.artifacts, initialEvaluation(input, input.modelName));
    expect(await getEvaluation(fixture.artifacts, input, input.id)).toBeDefined();
    expect(evaluationPrefix(input, input.id)).toStartWith(
      `evaluations/benchmarks/${input.benchmarkId}/`,
    );

    // Each benchmark lists its own comparisons and runs; other boxes and the repository list none.
    const listed = await (await fixture.request(`${base}/comparisons`)).json();
    expect(listed.comparisons.map((comparison: { id: string }) => comparison.id)).toEqual([id]);
    const other = `${fixture.benchmarks}/hello-world/hello-world/evaluations`;
    expect((await (await fixture.request(`${other}/comparisons`)).json()).comparisons).toEqual([]);
    expect((await (await fixture.request(fixture.base)).json()).runs).toEqual([]);
    expect(
      (await (await fixture.request(base)).json()).runs.map((run: { id: string }) => run.id),
    ).toEqual([input.id]);
    expect((await fixture.request(`${base}/${input.id}`)).status).toBe(200);
    expect((await fixture.request(`${other}/${input.id}`)).status).toBe(404);
    expect((await fixture.request(`${other}/comparisons/${id}`)).status).toBe(404);
    expect((await fixture.request(`${base}/comparisons/${id}`, {}, 2)).status).toBe(404);
    const boxesNow = (await (await fixture.request(fixture.benchmarks)).json()).benchmarks;
    expect(boxesNow[0].runs).toBe(1);

    const cancelled = await fixture.request(`${base}/comparisons/${id}/cancel`, post({}));
    expect(cancelled.status).toBe(200);
    expect(fixture.stops).toEqual([`evaluation/benchmark-${input.benchmarkId}/${input.id}`]);

    // Removing a box drops it from the list; its evaluations are no longer served.
    const removed = await fixture.request(`${fixture.benchmarks}/terminal-bench/dataset`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect((await fixture.request(`${base}/comparisons/${id}`)).status).toBe(404);
    expect(
      (await (await fixture.request(fixture.benchmarks)).json()).benchmarks.map(
        (box: { name: string }) => box.name,
      ),
    ).toEqual(["hello-world/hello-world"]);
  } finally {
    await fixture.close();
  }
});
