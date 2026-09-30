import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { EvaluationRun, EvaluationTrial } from "./api";
import { ResultsOverview } from "./ResultsOverview";
import { needsAttention, reviewOf } from "./results-alerts";
import { configurationsOf } from "./results-model";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const credentials: CredentialInfo[] = [
  { id: "openai-key", name: "OpenAI", kind: "openai", auth: "api-key", createdAt: at(9999) },
  {
    id: "gpu-a",
    name: "A",
    kind: "custom",
    auth: "api-key",
    createdAt: at(9999),
    endpoint: "https://gpu.example.test/a/v1",
  },
  {
    id: "gpu-b",
    name: "B",
    kind: "custom",
    auth: "api-key",
    createdAt: at(9999),
    endpoint: "https://gpu.example.test/b/v1",
  },
];

type TrialSpec = Partial<EvaluationTrial> & { taskId: string };
const passed = (taskId: string, minutes = 10): TrialSpec => ({
  taskId,
  status: "completed",
  rewards: { reward: 1 },
  modelVerified: true,
  apiCostUsd: 0.5,
  startedAt: at(200),
  finishedAt: at(200 - minutes),
});
const errored = (taskId: string, error: string): TrialSpec => ({
  taskId,
  status: "failed",
  error,
  startedAt: at(200),
  finishedAt: at(190),
});

function run(
  id: string,
  options: Partial<EvaluationRun> & { credential?: string },
  trials: TrialSpec[],
): EvaluationRun {
  const { credential = "openai-key", ...rest } = options;
  const custom = credential.startsWith("gpu");
  return {
    id,
    repoId: 1,
    tenant: "example",
    startedBy: "priya",
    createdAt: at(300),
    model: custom ? "custom" : "gpt-6",
    modelName: custom ? "openai/llama-70b" : "openai/gpt-6",
    modelLabel: custom ? "llama-70b" : "GPT-6",
    thinking: "high",
    harnesses: ["codex"],
    sandbox: "modal",
    credentials: {
      modelCredentialId: credential,
      sandboxCredentialId: "modal",
      provider: custom ? "custom" : "openai",
    },
    revision: 1,
    status: "completed",
    trials: trials.map((trial) => ({
      runId: "batch-1",
      harness: "codex",
      status: "queued",
      rewards: {},
      log: "",
      steps: [],
      artifacts: [],
      ...trial,
    })),
    ...rest,
  };
}

test("groups runs by release setting, then by comparison, and counts each task's latest result", () => {
  const first = run("first", { comparisonId: "c1", createdAt: at(300) }, [
    passed("task-1"),
    errored("task-2", "Harbor exited with code 137"),
  ]);
  const rerun = run("rerun", { comparisonId: "c2", createdAt: at(100), startedBy: "sam" }, [
    passed("task-2"),
  ]);
  const other = run("other", { thinking: "low" }, [passed("task-1")]);
  const [configuration, low, ...rest] = configurationsOf([first, rerun, other], credentials, NOW);
  expect(rest).toEqual([]);
  expect(low?.thinking).toBe("low");
  expect(configuration?.batches.map((batch) => [batch.id, batch.startedBy])).toEqual([
    ["c1", "priya"],
    ["c2", "sam"],
  ]);
  expect(configuration?.latest.map((result) => [result.trial.taskId, result.outcome])).toEqual([
    ["task-1", "passed"],
    ["task-2", "passed"],
  ]);
  const replaced = configuration?.batches[0]?.results[1];
  expect(replaced?.outcome).toBe("error");
  expect(replaced?.replacedBy?.run.id).toBe("rerun");
  expect(configuration).toMatchObject({
    finished: 2,
    passRate: 100,
    costPerTask: 0.5,
    spend: 1,
    status: "done",
  });
  // The replaced error is no longer a problem.
  expect(reviewOf(configurationsOf([first, rerun], credentials, NOW), NOW).alerts).toEqual([]);
});

test("custom endpoints serving one model are separate configurations, numbered as a release would", () => {
  const configurations = configurationsOf(
    [
      run("a", { credential: "gpu-a" }, [passed("task-1")]),
      run("b", { credential: "gpu-b" }, [passed("task-1")]),
    ],
    credentials,
    NOW,
  );
  expect(
    configurations
      .map((configuration) => [configuration.endpoint, configuration.endpointNumber])
      .sort(),
  ).toEqual([
    ["https://gpu.example.test/a/v1", 1],
    ["https://gpu.example.test/b/v1", 2],
  ]);
  expect(configurations[0]?.label).toBe("llama-70b");
});

test("running, queued and cancelled configurations", () => {
  const running = run("running", { status: "running" }, [
    passed("task-1"),
    { taskId: "task-2", status: "running", startedAt: at(5) },
    { taskId: "task-3" },
  ]);
  const queued = run("queued", { status: "queued", thinking: "low" }, [{ taskId: "task-1" }]);
  const cancelled = run(
    "cancelled",
    { status: "failed", error: "Cancelled by sam.", finishedAt: at(1), thinking: "medium" },
    [passed("task-1"), errored("task-2", "Cancelled before this trial completed")],
  );
  const configurations = configurationsOf([running, queued, cancelled], credentials, NOW);
  const status = Object.fromEntries(
    configurations.map((configuration) => [configuration.thinking, configuration.status]),
  );
  expect(status).toEqual({ high: "running", low: "queued", medium: "cancelled" });
  const review = reviewOf(configurations, NOW);
  expect(review.alerts.map((alert) => alert.kind)).toEqual(["cancelled"]);
  expect(review.alerts[0]?.title).toContain("cancelled by sam");
  expect(configurations.some((configuration) => needsAttention(review, configuration))).toBe(false);
});

test("a started run whose tasks are all queued is preparing, and can stall", () => {
  // An earlier batch's 20-minute task doesn't shorten the limit for setup.
  const earlier = run("earlier", { createdAt: at(400) }, [passed("task-1", 20)]);
  const preparing = run("preparing", { status: "running", createdAt: at(80) }, [
    { taskId: "task-1" },
    { taskId: "task-2" },
  ]);
  expect(reviewOf(configurationsOf([earlier, preparing], credentials, NOW), NOW).alerts).toEqual(
    [],
  );
  preparing.createdAt = at(120);
  const waiting = run("waiting", { status: "queued", thinking: "low" }, [{ taskId: "task-1" }]);
  const configurations = configurationsOf([preparing, waiting], credentials, NOW);
  expect(configurations.map((configuration) => configuration.status).sort()).toEqual([
    "queued",
    "running",
  ]);
  const review = reviewOf(configurations, NOW);
  expect(review.alerts.map((alert) => alert.kind)).toEqual(["stalled"]);
  expect(review.alerts[0]?.detail).toStartWith("Still preparing, and nothing has");
});

test("a repeated error, results that won't chart, and a stall need attention", () => {
  const broken = run("broken", {}, [
    errored("task-1", "Harbor exited with code 137"),
    errored("task-2", "Harbor exited with code 137\nat line 4"),
    errored("task-3", "Harbor exited with code 137"),
    { ...passed("task-4"), modelVerified: false },
  ]);
  const stalled = run("stalled", { status: "running", thinking: "low" }, [
    passed("task-1", 20),
    { taskId: "task-2", status: "running", startedAt: at(150) },
  ]);
  const configurations = configurationsOf([broken, stalled], credentials, NOW);
  const review = reviewOf(configurations, NOW);
  expect(review.alerts.map((alert) => alert.kind)).toEqual([
    "repeated-error",
    "wont-chart",
    "stalled",
  ]);
  expect(review.alerts[0]?.detail).toContain("“Harbor exited with code 137”");
  const flags = (thinking: string) =>
    review.flags.get(configurations.find((entry) => entry.thinking === thinking)?.key ?? "");
  expect(flags("high")?.map((flag) => flag.text)).toEqual(["3 Errors", "Won’t Chart"]);
  expect(flags("low")?.map((flag) => flag.text)).toEqual(["Stalled"]);
  expect(configurations.every((configuration) => needsAttention(review, configuration))).toBe(true);
});

test("a task that errors the same way on three configurations is the task's problem", () => {
  const runs = (["low", "medium", "high"] as const).map((thinking) =>
    run(thinking, { thinking }, [
      passed("earendil-works-pi-pr-17"),
      errored("earendil-works-pi-pr-30", "Task bundle is missing or exceeds 100 MiB"),
    ]),
  );
  const configurations = configurationsOf(runs, credentials, NOW);
  const review = reviewOf(configurations, NOW);
  expect(review.alerts).toHaveLength(1);
  expect(review.alerts[0]).toMatchObject({
    kind: "task-problem",
    title: "PR #30 errored on 3 configurations",
    task: { key: "batch-1/earendil-works-pi-pr-30", name: "PR #30" },
  });
  for (const configuration of configurations) {
    expect(review.flags.get(configuration.key)).toEqual([{ severity: "task", text: "PR #30" }]);
    // On its own, a task's problem isn't the configuration's.
    expect(needsAttention(review, configuration)).toBe(false);
  }
});

test("the overview lists what needs a look first, with the error inline and the rest folded", () => {
  const trials = [
    ...["task-1", "task-2", "task-3"].map((taskId) =>
      errored(taskId, "Harbor exited with code 137"),
    ),
    ...Array.from({ length: 8 }, (_, index) => passed(`task-${index + 4}`)),
  ];
  const html = renderToStaticMarkup(
    <ResultsOverview
      runs={[run("broken", {}, trials)]}
      credentials={credentials}
      onOpenRun={() => {}}
    >
      <p>Chart</p>
    </ResultsOverview>,
  );
  for (const text of [
    ">Configurations<",
    ">Need Attention<",
    ">Model Spend<",
    "3 GPT-6 · Codex tasks failed with the same error",
    ">Needs Attention<",
    ">3 Errors<",
    "high · Codex · API Key",
    "started by priya · 11 tasks",
    "8 more: 8 passed",
    "Show All 11 Tasks",
    "Harbor exited with code 137",
  ]) {
    expect(html).toContain(text);
  }
  // The summary and alerts come before the chart, the table after it.
  expect(html.indexOf("Model Spend")).toBeLessThan(html.indexOf("<p>Chart</p>"));
  expect(html.indexOf("<p>Chart</p>")).toBeLessThan(html.indexOf("Pass Rate"));
});
