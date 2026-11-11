import { expect, test } from "bun:test";
import { conditionSchema, skillSource } from "../src/contracts/conditions.js";
import type { ComparisonDraft } from "../src/evaluation/comparisons.js";
import { conditionArguments, runCondition } from "../src/evaluation/conditions.js";
import { solverArguments } from "../src/evaluation/solver-arguments.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationRun } from "../src/evaluation/types.js";
import { previewRelease } from "../src/public/release-build.js";
import { resultsBySetting } from "../src/public/release-results.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { approvedTasks, inputs, run } from "./support/release-fixture.js";

test("a skill is always a GitHub URL, never a path on the worker", () => {
  expect(skillSource("vercel/next.js")).toBe("https://github.com/vercel/next.js");
  expect(skillSource("vercel/next.js@canary")).toBe(
    "https://github.com/vercel/next.js/tree/canary",
  );
  expect(skillSource("https://github.com/acme/skills.git")).toBe("https://github.com/acme/skills");
  expect(skillSource("https://github.com/acme/skills/tree/v2")).toBe(
    "https://github.com/acme/skills/tree/v2",
  );
  for (const unsafe of [
    "/etc",
    "./skills",
    "../skills",
    "~/skills",
    "acme/../etc",
    "acme/skills/extra",
    "acme/skills@main/../../x",
    "http://github.com/acme/skills",
    "https://evil.example/acme/skills",
    "https://github.com/acme/skills/tree/main/../../x",
    "file:///etc/skills",
  ])
    expect(skillSource(unsafe)).toBeUndefined();
});

test("a condition's id follows what it changes, and Harbor gets its skills and instructions", () => {
  const parsed = conditionSchema.parse({
    name: "With Next Skills",
    skills: ["vercel/next.js@canary", "https://github.com/vercel/next.js/tree/canary"],
    instructions: "  Read the docs first.  ",
  });
  const condition = runCondition(parsed);
  expect(condition.skills).toEqual(["https://github.com/vercel/next.js/tree/canary"]);
  expect(runCondition({ ...parsed, name: "Renamed" }).id).toBe(condition.id);
  const pair = { name: "Pair", skills: ["https://github.com/a/one", "https://github.com/a/two"] };
  expect(runCondition({ ...pair, skills: [...pair.skills].reverse() }).id).toBe(
    runCondition(pair).id,
  );
  expect(runCondition({ ...parsed, instructions: "Other." }).id).not.toBe(condition.id);
  expect(() => conditionSchema.parse({ name: "Nothing", skills: [] })).toThrow();

  const args = solverArguments(
    "task",
    "jobs",
    { agent: "pi", model: "m", agentArguments: ["--ak", "x=1"] },
    "modal",
    [],
    [],
    { condition, harness: "pi" },
  );
  expect(args.slice(-6)).toEqual([
    "--skill",
    "https://github.com/vercel/next.js/tree/canary",
    "--extra-instruction",
    "Read the docs first.",
    "--ak",
    "x=1",
  ]);
  expect(conditionArguments(undefined, "pi")).toEqual([]);
});

test("a comparison runs every model under the baseline and each condition, kept apart", async () => {
  const fixture = await evaluationServer();
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const save = async (kind: string) =>
      (
        await (
          await fixture.request(
            "/api/orgs/avyay/credentials",
            post({ kind, name: kind, value: `fake-${kind}` }),
          )
        ).json()
      ).id as string;
    const credentialId = await save("openrouter");
    const sandboxCredentialId = await save("e2b");
    const meta = await save("meta");
    const draft: ComparisonDraft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      sandbox: "e2b",
      sandboxCredentialId,
      models: [{ catalogId: "gpt-6-sol", credentialId, harnesses: ["pi"], thinking: "high" }],
      conditions: [{ name: "With Skills", skills: ["vercel/next.js"] }],
    };
    const started = await fixture.request(`${fixture.base}/comparisons`, post(draft));
    expect(started.status).toBe(202);
    expect(fixture.starts.map((input) => input.condition?.name)).toEqual([
      undefined,
      "With Skills",
    ]);
    const conditioned = fixture.starts[1];
    if (!conditioned) throw new Error("Missing conditioned input");
    expect(conditioned.condition?.skills).toEqual(["https://github.com/vercel/next.js"]);

    // Results keep the condition apart, and the baseline keeps the key it always had.
    const runs = fixture.starts.map((input) => {
      const run: EvaluationRun = initialEvaluation(input, "GPT-6 Sol");
      run.credentials = {
        modelCredentialId: credentialId,
        provider: "openrouter",
        sandboxCredentialId,
      };
      for (const trial of run.trials) {
        trial.status = "completed";
        trial.finishedAt = new Date().toISOString();
        trial.rewards = { reward: 1 };
        trial.modelVerified = true;
        trial.apiCostUsd = 0.1;
      }
      return run;
    });
    const settings = [...resultsBySetting(runs).values()].map(({ setting }) => setting);
    expect(settings.map((setting) => [setting.key, setting.condition?.name])).toEqual([
      [JSON.stringify(["gpt-6-sol", "pi", "high"]), undefined],
      [JSON.stringify(["gpt-6-sol", "pi", "high", conditioned.condition?.id]), "With Skills"],
    ]);

    // "Missing only" skips per condition: the conditioned run still counts as missing.
    for (const run of runs.slice(0, 1)) {
      run.status = "completed";
      await saveEvaluation(fixture.artifacts, run);
    }
    const missing = await fixture.request(
      `${fixture.base}/comparisons`,
      post({ ...draft, id: crypto.randomUUID(), skipCompleted: true }),
    );
    expect(missing.status).toBe(202);
    expect(fixture.starts.slice(2).map((input) => input.condition?.name)).toEqual(["With Skills"]);

    // Only the conditions, and never skills on a harness that can't load them.
    const only = await fixture.request(
      `${fixture.base}/comparisons`,
      post({ ...draft, id: crypto.randomUUID(), baseline: false }),
    );
    expect(only.status).toBe(202);
    expect(fixture.starts.slice(3).map((input) => input.condition?.name)).toEqual(["With Skills"]);
    const nothing = await fixture.request(
      `${fixture.base}/comparisons`,
      post({ ...draft, id: crypto.randomUUID(), baseline: false, conditions: [] }),
    );
    expect(await nothing.json()).toEqual({ error: "Run the baseline or at least one condition" });
    const muse = await fixture.request(
      `${fixture.base}/comparisons`,
      post({
        ...draft,
        id: crypto.randomUUID(),
        models: [{ catalogId: "muse-spark-1.3", credentialId: meta, harnesses: ["muse-code"] }],
      }),
    );
    expect(await muse.json()).toEqual({
      error: "With Skills adds skills, which only Claude Code, Codex, and Pi load",
    });
    const path = await fixture.request(
      `${fixture.base}/comparisons`,
      post({
        ...draft,
        id: crypto.randomUUID(),
        conditions: [{ name: "Local", skills: ["/etc"] }],
      }),
    );
    expect(path.status).toBe(400);
    expect(fixture.starts).toHaveLength(4);
  } finally {
    await fixture.close();
  }
});

test("a release publishes the baseline, never a run condition", () => {
  const source = inputs({
    tasks: approvedTasks(["t1"]),
    runs: [
      run({ model: "sol", results: { t1: 1 } }),
      {
        ...run({ model: "sol", results: { t1: 1 } }),
        id: "conditioned",
        condition: runCondition({ name: "With Skills", skills: ["https://github.com/a/b"] }),
      },
    ],
  });
  expect(previewRelease(source).settings.map((setting) => setting.condition)).toEqual([undefined]);
});

test("a condition with an environment runs each ready task from its variant, as the task", async () => {
  const fixture = await evaluationServer();
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const save = async (kind: string) =>
      (
        await (
          await fixture.request(
            "/api/orgs/avyay/credentials",
            post({ kind, name: kind, value: `fake-${kind}` }),
          )
        ).json()
      ).id as string;
    const credentialId = await save("openrouter");
    const sandboxCredentialId = await save("e2b");
    const task = await fixture.tasks.find(fixture.repo.id, "run-one", "task-one");
    if (!task) throw new Error("Missing fixture task");
    const environment = await fixture.tasks.variants.createEnvironment({
      repoId: fixture.repo.id,
      name: "No AGENTS.md",
      changes: { packages: [], files: [{ path: "AGENTS.md", mode: "delete", content: "" }] },
      createdBy: fixture.user.id,
    });
    const variant = await fixture.tasks.variants.reserve({
      environmentId: environment.id,
      parentId: task.id,
      repoId: fixture.repo.id,
      runId: "scn-variant",
      candidateId: task.candidateId,
      taskId: task.taskId,
      startedBy: fixture.user.id,
    });
    const draft = {
      id: crypto.randomUUID(),
      sandbox: "e2b",
      sandboxCredentialId,
      models: [{ catalogId: "gpt-6-sol", credentialId, harnesses: ["pi"], thinking: "high" }],
      conditions: [{ name: "No AGENTS.md", environment: environment.id }],
    };
    // Nothing is ready yet, so the condition has nothing to run.
    const early = await fixture.request(`${fixture.base}/comparisons`, post(draft));
    expect(await early.json()).toEqual({
      error: "No AGENTS.md: no picked task is ready in No AGENTS.md yet",
    });
    await fixture.tasks.variants.settle(variant.runId, variant.candidateId, {
      pipelineStatus: "accepted",
      stage: "accepted",
      bundleKey: "runs/scn-variant/harbor-task.tar.gz",
    });
    const started = await fixture.request(
      `${fixture.base}/comparisons`,
      post({ ...draft, id: crypto.randomUUID() }),
    );
    expect(started.status).toBe(202);
    const [baseline, conditioned] = fixture.starts;
    expect(baseline?.tasks).toEqual([expect.objectContaining({ bundleKey: "tasks/task.tar.gz" })]);
    expect(conditioned?.condition).toMatchObject({
      name: "No AGENTS.md",
      environment: { id: environment.id, name: "No AGENTS.md" },
    });
    expect(conditioned?.tasks).toEqual([
      expect.objectContaining({
        runId: "run-one",
        taskId: "task-one",
        bundleKey: "runs/scn-variant/harbor-task.tar.gz",
      }),
    ]);
    const unknown = await fixture.request(
      `${fixture.base}/comparisons`,
      post({ ...draft, id: crypto.randomUUID(), conditions: [{ name: "Gone", environment: 999 }] }),
    );
    expect(await unknown.json()).toEqual({ error: "Gone: no such environment in this repository" });
  } finally {
    await fixture.close();
  }
});
