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
    rewards: { reward, patch_applied: 1, fail_to_pass: reward, pass_to_pass: 1 },
    // Sections as output.ts `trialLog` writes them: only the verifier's test output is public.
    log: [
      "--- Harbor output ---\nrouted through https://private-endpoint.example.com",
      "--- solver/harbor-task__x/verifier/test-stdout.txt ---\nPASS chunks.test.ts\nGH_AUTH_TOKEN=ghsecretvalue1234",
      "--- solver/harbor-task__x/trial.log ---\nsandbox sb-7f3a2 started",
    ].join("\n\n"),
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
          {
            id: "t",
            name: "bash",
            input: "env",
            output:
              "OPENAI_API_KEY=sk-abcdefghijklmnop1234\nOPENAI_BASE_URL=https://gw.internal.example/v1\nPOST https://private-endpoint.example.com/v1/chat",
          },
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

/** The transcripts runs kept, by run and artifact name. */
const ARTIFACTS: Record<string, string> = {};

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
    endpointHosts: ["private-endpoint.example.com"],
  };
  const routes = createPublicReleaseRoutes(
    {
      currentLines: async () => [line("with-trials", true), line("tasks-only", false)],
      releasedTasks: async () => [task("next-pr-1"), task("next-pr-2")],
      releasedResults: async () => released,
    },
    {
      artifacts: { stat: async () => undefined, openReadByKey: async () => undefined },
      trials: {
        run: async (at, evaluationId) => {
          runReads.push(evaluationId);
          return at.orgId === LINE.orgId ? RUNS[evaluationId] : undefined;
        },
        artifact: async (_at, evaluationId, name) => ARTIFACTS[`${evaluationId}/${name}`],
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

test("a trial is its result, grading, and redacted transcript, never the rest of its log", async () => {
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
  expect(trial.rewards).toEqual({ reward: 0, patch_applied: 1, fail_to_pass: 0, pass_to_pass: 1 });
  expect(trial.verifierOutput).toStartWith("PASS chunks.test.ts\n");
  for (const hidden of [
    "private-endpoint",
    "sb-7f3a2",
    "gw.internal.example",
    "ghsecretvalue1234",
    "billedCostUsd",
    "trajectory.json",
  ])
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

test("a trial recorded before whole transcripts were read is read again from the one it kept", async () => {
  const { get } = await serve();
  const name = "0/solver/harbor-task__x/agent/pi.txt";
  const custom = RUNS["run-custom"]?.trials[0];
  if (!custom) throw new Error("missing trial");
  custom.artifacts = [name];
  // Only the end of the log was kept, but Pi's last event repeats the whole conversation.
  ARTIFACTS[`run-custom/${name}`] = [
    '[Earlier output truncated]\n"partial":true}',
    JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "Order the chunks by path." }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Editing the emitter." },
            { type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/chunk.rs" } },
          ],
        },
        { role: "toolResult", toolCallId: "e1", content: [{ type: "text", text: "Edited." }] },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ],
    }),
  ].join("\n");
  try {
    const response = await get(
      `with-trials/tasks/next-pr-1/trials/${encodeURIComponent("custom/qwen|pi|default")}`,
    );
    const trial = (await response.json()) as PublishedTrial;
    expect(trial.steps.map((step) => step.text)).toEqual([
      "Order the chunks by path.",
      "Editing the emitter.",
      "Done.",
    ]);
    expect(trial.steps[1]?.tools[0]).toMatchObject({ name: "edit", output: "Edited." });
  } finally {
    custom.artifacts = ["0/agent/trajectory.json"];
    delete ARTIFACTS[`run-custom/${name}`];
  }
});

test("a trial whose run could not be found is read again on the next request", async () => {
  const { get, runReads } = await serve();
  const run = RUNS["run-sol"];
  delete RUNS["run-sol"];
  try {
    expect((await get(`with-trials/tasks/next-pr-1/trials/${SOL_ID}`)).status).toBe(404);
  } finally {
    if (run) RUNS["run-sol"] = run;
  }
  expect((await get(`with-trials/tasks/next-pr-1/trials/${SOL_ID}`)).status).toBe(200);
  // The second task's trial shares the run read for the first.
  expect((await get(`with-trials/tasks/next-pr-2/trials/${SOL_ID}`)).status).toBe(200);
  expect(runReads).toEqual(["run-sol", "run-sol"]);
});
