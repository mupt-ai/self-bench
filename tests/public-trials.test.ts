import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { sendApiError } from "../src/api/http.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import type { ReleaseLine } from "../src/db/releases.js";
import type { EvaluationRun, EvaluationTrial } from "../src/evaluation/types.js";
import type { ReleaseTask } from "../src/public/release-rule.js";
import type { ReleasedResults } from "../src/public/release-trials.js";
import type { PublishedLine, PublishedTrial } from "../src/public/release-types.js";

const LINE: ReleaseLine = { orgId: 7, githubRepoId: 70107786 };
const SOL = JSON.stringify(["sol", "codex", "high"]);
const CUSTOM = JSON.stringify(["custom/qwen", "pi", "default"]);

const task = (taskId: string): ReleaseTask => ({
  key: JSON.stringify(["batch-1", taskId]),
  runId: "batch-1",
  taskId,
  difficulty: "medium",
  state: "accepted",
  runnable: true,
});

const trial = (taskId: string, harness: EvaluationTrial["harness"], reward: number) =>
  ({
    taskId,
    runId: "batch-1",
    harness,
    status: "completed",
    rewards: { reward },
    log: "Harbor output naming https://private-endpoint.example.com",
    artifacts: ["0/agent/trajectory.json"],
    error: "upstream https://private-endpoint.example.com refused",
    startedAt: "2026-10-01T00:00:00Z",
    finishedAt: "2026-10-01T00:04:00Z",
    apiCostUsd: 0.42,
    billedCostUsd: 0.4,
    steps: [
      { id: "1", role: "user", text: "Order the chunks by path.", tools: [] },
      {
        id: "2",
        role: "assistant",
        text: "Checking the environment.",
        tools: [
          { id: "t", name: "bash", input: "env", output: "OPENAI_API_KEY=sk-abcdefghijklmnop1234" },
        ],
      },
    ],
  }) satisfies EvaluationTrial;

/** One run per setting: Sol passed the first task and failed the second, the custom model both. */
const RUNS: Record<string, EvaluationRun> = {
  "run-sol": {
    trials: [trial("next-pr-1", "codex", 1), trial("next-pr-2", "codex", 0)],
    agentMinutes: 30,
  } as unknown as EvaluationRun,
  "run-custom": {
    trials: [trial("next-pr-1", "pi", 1), trial("next-pr-2", "pi", 1)],
  } as unknown as EvaluationRun,
};

const results = (evaluationId: string, passes: boolean[]) =>
  Object.fromEntries(
    ["next-pr-1", "next-pr-2"].map((id, index) => [
      JSON.stringify(["batch-1", id]),
      { pass: passes[index] === true, evaluationId, trialIndex: index },
    ]),
  );

const line = (releaseId: string, trialsPublished: boolean): PublishedLine => ({
  release: {
    schemaVersion: 1,
    releaseId,
    releasedAt: "2026-10-01T00:00:00Z",
    repository: { id: LINE.githubRepoId, fullName: "vercel/next.js" },
    publisher: { login: "mupt-ai", kind: "org" },
    tasks: 2,
    settings: [],
    frontier: [],
    tasksPublished: true,
    ...(trialsPublished ? { trialsPublished: true as const } : {}),
  },
  endorsed: false,
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Two releases of the same results that published their tasks; only one its trials too. */
async function serve() {
  const runReads: string[] = [];
  const released: ReleasedResults = {
    line: LINE,
    results: { [SOL]: results("run-sol", [true, false]), [CUSTOM]: results("run-custom", [true]) },
  };
  const routes = createPublicReleaseRoutes(
    {
      currentLines: async () => [line("with-trials", true), line("tasks-only", false)],
      releasedTasks: async () => [task("next-pr-1"), task("next-pr-2")],
      releasedResults: async () => released,
    },
    {
      artifacts: { stat: async () => undefined, openReadByKey: async () => undefined },
      releasedRun: async (at, evaluationId) => {
        runReads.push(evaluationId);
        return at.orgId === LINE.orgId ? RUNS[evaluationId] : undefined;
      },
    },
  );
  const server = createServer(async (request, response) => {
    try {
      await routes.handle(request, new URL(request.url ?? "/", "http://localhost"), response);
    } catch (error) {
      sendApiError(response, error);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const get = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${address.port}/api/public/releases/${path}`, init);
  return { get, runReads };
}

const SOL_ID = encodeURIComponent("sol|codex|high");

test("a release that published its trials lists whether each setting passed each task", async () => {
  const { get } = await serve();
  const { tasks } = (await (await get("with-trials/tasks")).json()) as {
    tasks: { id: string; passed?: Record<string, boolean> }[];
  };
  expect(tasks.map((entry) => [entry.id, entry.passed])).toEqual([
    ["next-pr-1", { "sol|codex|high": true, "custom/qwen|pi|default": true }],
    ["next-pr-2", { "sol|codex|high": false, "custom/qwen|pi|default": false }],
  ]);
  const quiet = (await (await get("tasks-only/tasks")).json()) as { tasks: object[] };
  expect(quiet.tasks.every((entry) => !("passed" in entry))).toBe(true);
});

test("a trial is its result and redacted transcript, never its log, artifacts, or error", async () => {
  const { get } = await serve();
  const response = await get(`with-trials/tasks/next-pr-2/trials/${SOL_ID}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
  const body = await response.text();
  const trial = JSON.parse(body) as PublishedTrial;
  expect(trial).toMatchObject({
    taskId: "next-pr-2",
    settingId: "sol|codex|high",
    passed: false,
    agentMinutes: 30,
    apiCostUsd: 0.42,
  });
  expect(trial.steps.map((step) => step.text)).toEqual([
    "Order the chunks by path.",
    "Checking the environment.",
  ]);
  expect(body).not.toContain("sk-abcdefghijklmnop1234");
  for (const hidden of ["private-endpoint", "billedCostUsd", "trajectory.json"])
    expect(body).not.toContain(hidden);
  // The custom model's id has a slash in it, encoded in the address.
  const custom = await get(
    `with-trials/tasks/next-pr-1/trials/${encodeURIComponent("custom/qwen|pi|default")}`,
  );
  expect(((await custom.json()) as PublishedTrial).passed).toBe(true);
});

test("each trial reads its run once, and a 304 once the browser holds it", async () => {
  const { get, runReads } = await serve();
  const first = await get(`with-trials/tasks/next-pr-1/trials/${SOL_ID}`);
  const again = await get(`with-trials/tasks/next-pr-1/trials/${SOL_ID}`, {
    headers: { "if-none-match": first.headers.get("etag") ?? "" },
  });
  expect(again.status).toBe(304);
  expect(runReads).toEqual(["run-sol"]);
});

test("trials are served only from a release that published them, as the release recorded them", async () => {
  const { get } = await serve();
  for (const path of [
    `tasks-only/tasks/next-pr-1/trials/${SOL_ID}`,
    `with-trials/tasks/next-pr-9/trials/${SOL_ID}`,
    `with-trials/tasks/next-pr-1/trials/${encodeURIComponent("sol|pi|high")}`,
    "with-trials/tasks/next-pr-1/trials/%E0%A4%A",
  ]) {
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

test("a trial its run no longer holds where the release recorded it is not found", async () => {
  const { get } = await serve();
  // The run's trials in another order: the recorded place now holds the other task's trial.
  RUNS["run-custom"]?.trials.reverse();
  try {
    const response = await get(
      `with-trials/tasks/next-pr-1/trials/${encodeURIComponent("custom/qwen|pi|default")}`,
    );
    expect(response.status).toBe(404);
  } finally {
    RUNS["run-custom"]?.trials.reverse();
  }
});
