import { expect, test } from "bun:test";
import type { EvaluationRun } from "./api";
import { missingWork } from "./run-missing";

const tasks = ["t1", "t2", "t3"].map((taskId) => ({ runId: "gen", taskId }));
const credentials = [
  { id: "key", kind: "openai" as const },
  { id: "sandbox", kind: "modal" as const },
];
let ids = 0;
const newId = () => `id-${++ids}`;

function run(
  model: string,
  harness: "codex" | "pi",
  trials: Record<string, EvaluationRun["trials"][number]["status"]>,
  more: Partial<EvaluationRun> = {},
): EvaluationRun {
  return {
    id: `${model}-${harness}-${Object.keys(trials).join("")}`,
    repoId: 1,
    tenant: "acme",
    startedBy: "priya",
    createdAt: "2026-11-01T00:00:00Z",
    model,
    modelName: `openai/${model}`,
    thinking: "high",
    harnesses: [harness],
    sandbox: "modal",
    credentials: { modelCredentialId: "key", sandboxCredentialId: "sandbox", provider: "openai" },
    revision: 1,
    modelLabel: model.toUpperCase(),
    status: "completed",
    trials: Object.entries(trials).map(([taskId, status]) => ({
      runId: "gen",
      taskId,
      harness,
      status,
      rewards: { reward: 1 },
      log: "",
      steps: [],
      artifacts: [],
    })),
    ...more,
  } as EvaluationRun;
}

test("each setting run before gets its new and errored tasks, as it ran", () => {
  const work = missingWork(
    [
      // Sol passed t1, errored on t2, never saw t3.
      run("sol", "codex", { t1: "completed", t2: "failed" }),
      // Luna is still running t3: running it again would run it twice.
      run("luna", "codex", { t1: "completed", t2: "completed", t3: "running" }),
    ],
    tasks,
    credentials,
    newId,
  );
  expect(work?.settings).toEqual([{ label: "SOL · Codex · high", harness: "codex", missing: 2 }]);
  expect(work?.trials).toBe(2);
  expect(work?.selections).toHaveLength(1);
  expect(work?.selections[0]).toMatchObject({
    models: [{ catalogId: "sol", credentialId: "key", thinking: "high", harnesses: ["codex"] }],
    sandbox: "modal",
    sandboxCredentialId: "sandbox",
    tasks: [
      { runId: "gen", taskId: "t2" },
      { runId: "gen", taskId: "t3" },
    ],
    skipCompleted: true,
  });
});

test("harnesses of one model share an entry, and a gone credential's settings are left out", () => {
  const work = missingWork(
    [
      run("sol", "codex", { t1: "completed" }),
      run("sol", "pi", { t1: "completed" }),
      run(
        "gone",
        "codex",
        {},
        {
          credentials: {
            modelCredentialId: "deleted",
            sandboxCredentialId: "s",
            provider: "openai",
          },
        },
      ),
    ],
    tasks,
    credentials,
    newId,
  );
  expect(work?.selections[0]?.models).toEqual([
    { catalogId: "sol", credentialId: "key", thinking: "high", harnesses: ["codex", "pi"] },
  ]);
  expect(work?.trials).toBe(4);
});

test("nothing is missing once every setting completed every task, and twelve models fill a comparison", () => {
  expect(
    missingWork(
      [run("sol", "codex", { t1: "completed", t2: "completed", t3: "completed" })],
      tasks,
      credentials,
      newId,
    ),
  ).toBeUndefined();
  const many = Array.from({ length: 13 }, (_, index) => run(`m${index}`, "codex", {}));
  const work = missingWork(many, tasks, credentials, newId);
  expect(work?.selections.map((selection) => selection.models.length)).toEqual([12, 1]);
  expect(new Set(work?.selections.map((selection) => selection.id)).size).toBe(2);
});

test("settings with different gaps go in different comparisons, so a running trial is not started again", () => {
  const work = missingWork(
    [
      // Sol misses t2 and t3; Luna is running t3 and misses only t2.
      run("sol", "codex", { t1: "completed" }),
      run("luna", "codex", { t1: "completed", t3: "running" }),
    ],
    tasks,
    credentials,
    newId,
  );
  const plan = work?.selections.map((selection) => [
    selection.models.map((model) => model.catalogId),
    selection.tasks.map((task) => task.taskId),
  ]);
  expect(plan).toEqual([
    [["sol"], ["t2", "t3"]],
    [["luna"], ["t2"]],
  ]);
});

test("one setting run with two credentials is one setting, on its newest credential", () => {
  const work = missingWork(
    [
      run("sol", "codex", { t1: "completed" }, { createdAt: "2026-10-01T00:00:00Z" }),
      run(
        "sol",
        "codex",
        { t2: "completed" },
        {
          id: "newer",
          createdAt: "2026-11-02T00:00:00Z",
          credentials: {
            modelCredentialId: "other",
            sandboxCredentialId: "sandbox",
            provider: "openai",
          },
        },
      ),
    ],
    tasks,
    [...credentials, { id: "other", kind: "openai" as const }],
    newId,
  );
  expect(work?.settings).toHaveLength(1);
  expect(work?.selections[0]?.models).toEqual([
    { catalogId: "sol", credentialId: "other", thinking: "high", harnesses: ["codex"] },
  ]);
  expect(work?.selections[0]?.tasks.map((task) => task.taskId)).toEqual(["t3"]);
});

test("harnesses of one model on different credentials stay separate entries", () => {
  const work = missingWork(
    [
      run(
        "sol",
        "codex",
        { t1: "completed" },
        {
          credentials: {
            modelCredentialId: "chatgpt",
            sandboxCredentialId: "sandbox",
            provider: "openai",
          },
        },
      ),
      run("sol", "pi", { t1: "completed" }),
    ],
    tasks,
    [...credentials, { id: "chatgpt", kind: "openai" as const }],
    newId,
  );
  expect(work?.selections).toHaveLength(1);
  expect(work?.selections[0]?.models.map((model) => [model.credentialId, model.harnesses])).toEqual(
    [
      ["chatgpt", ["codex"]],
      ["key", ["pi"]],
    ],
  );
});
