import { afterEach, expect, spyOn, test } from "bun:test";
import { scopePath } from "../src/api/cli/args.js";
import { selectionFromFlags } from "../src/api/cli/evaluations.js";
import { runCli } from "../src/api/cli/main.js";
import { cannedCli as cli } from "./support/cli-replies.js";

// A developer's own `self-bench login` must not leak into these tests.
process.env.XDG_CONFIG_HOME = "/nonexistent/selfbench-test-config";
const environment = { ...process.env };
afterEach(() => {
  process.env = { ...environment };
});

const repo = "/api/orgs/acme/repos/acme/app";

test("commands act on a repo, custom, or public benchmark, or a group, in the named workspace", () => {
  expect(scopePath({ repo: "acme/app" })).toBe(repo);
  // A custom benchmark is the repository evals/<slug>, named by its name or its slug.
  const custom = "/api/orgs/acme/repos/evals/data-import-bugs";
  expect(scopePath({ custom: "Data Import Bugs", org: "acme" })).toBe(custom);
  expect(scopePath({ custom: "data-import-bugs", org: "acme" })).toBe(custom);
  expect(scopePath({ repo: "evals/data-import-bugs", org: "acme" })).toBe(custom);
  expect(scopePath({ public: "harbor/swe", org: "acme" })).toBe(
    "/api/orgs/acme/benchmarks/harbor/swe",
  );
  expect(scopePath({ benchmark: "harbor/swe", org: "acme" })).toBe(
    "/api/orgs/acme/benchmarks/harbor/swe",
  );
  expect(scopePath({ group: "web", org: "acme" })).toBe("/api/orgs/acme/groups/web");
  expect(() => scopePath({ repo: "acme/app", group: "web" })).toThrow("name one of");
  expect(() => scopePath({ custom: "bugs", public: "harbor/swe" })).toThrow("name one of");
  expect(() => scopePath({})).toThrow("--repo");
});

test("compare flags become one batch of every model on the same harnesses", () => {
  const selection = selectionFromFlags({
    model: ["gpt-6.1-sol", "claude-fable-5"],
    harness: ["pi", "codex"],
    thinking: "high",
    task: ["batch-1/t-1"],
    "skip-completed": true,
  });
  expect(selection).toMatchObject({
    models: [
      {
        catalogId: "gpt-6.1-sol",
        credentialId: "managed-model",
        thinking: "high",
        harnesses: ["pi", "codex"],
      },
      {
        catalogId: "claude-fable-5",
        credentialId: "managed-model",
        thinking: "high",
        harnesses: ["pi", "codex"],
      },
    ],
    sandbox: "managed",
    sandboxCredentialId: "managed-sandbox",
    skipCompleted: true,
    tasks: [{ runId: "batch-1", taskId: "t-1" }],
  });
  expect(selectionFromFlags({ model: ["m"] }).models).toEqual([
    { catalogId: "m", credentialId: "managed-model", harnesses: ["pi"] },
  ]);
});

test("release publish releases exactly the preview it read, with its default settings", async () => {
  const preview = {
    preview: {
      fingerprint: "f".repeat(64),
      tasks: [{}],
      unrun: 0,
      settings: [
        {
          key: "a",
          label: "A",
          harness: "pi",
          reasoningLevel: "high",
          coverage: [0],
          ticked: true,
        },
        {
          key: "b",
          label: "B",
          harness: "pi",
          reasoningLevel: "high",
          coverage: [],
          ticked: false,
        },
      ],
    },
    head: { id: "11111111-1111-4111-8111-111111111111" },
  };
  const { sent } = await cli(["release", "publish", "--repo", "acme/app", "--publish-tasks"], {
    [`GET ${repo}/releases/preview`]: preview,
    [`POST ${repo}/releases`]: { release: { id: "r" } },
  });
  expect(sent.at(-1)?.body).toEqual({
    settings: ["a"],
    head: preview.head.id,
    fingerprint: preview.preview.fingerprint,
    publishTasks: true,
  });
  await expect(
    cli(["release", "publish", "--repo", "acme/app", "--setting", "zzz"], {
      [`GET ${repo}/releases/preview`]: preview,
    }),
  ).rejects.toThrow("not in the preview: zzz");
});

test("task explain asks for each unexplained failure, then shows the task's results", async () => {
  const report = {
    tasks: 1,
    configurations: [],
    taskResults: [
      {
        runId: "batch-1",
        taskId: "t-1",
        scored: 3,
        passed: 1,
        results: [
          { configuration: "a", passed: true, evaluationId: "e-1", harness: "pi" },
          { configuration: "b", passed: false, evaluationId: "e-2", harness: "codex" },
          {
            configuration: "c",
            passed: false,
            evaluationId: "e-3",
            harness: "pi",
            failureSummary: "Already explained.",
          },
        ],
      },
    ],
  };
  const results = `GET ${repo}/evaluations/results?runId=batch-1&taskId=t-1`;
  const { sent, printed } = await cli(["task", "explain", "batch-1", "t-1", "--repo", "acme/app"], {
    [results]: report,
    [`POST ${repo}/evaluations/e-2/explain`]: {},
  });
  expect(sent.filter((request) => request.method === "POST")).toEqual([
    {
      method: "POST",
      path: `${repo}/evaluations/e-2/explain`,
      body: { runId: "batch-1", taskId: "t-1", harness: "codex" },
    },
  ]);
  expect(printed).toEqual(report);
});

test("task audit refuses to run without a model, and a failed explanation surfaces its reason", async () => {
  await expect(cli(["task", "audit", "batch-1", "t-1", "--repo", "acme/app"], {})).rejects.toThrow(
    "--model and --credential",
  );
  const report = {
    tasks: 1,
    configurations: [],
    taskResults: [
      {
        runId: "batch-1",
        taskId: "t-1",
        scored: 1,
        passed: 0,
        results: [{ configuration: "b", passed: false, evaluationId: "e-2", harness: "codex" }],
      },
    ],
  };
  await expect(
    cli(["task", "explain", "batch-1", "t-1", "--repo", "acme/app", "--wait"], {
      [`GET ${repo}/evaluations/results?runId=batch-1&taskId=t-1`]: report,
      [`POST ${repo}/evaluations/e-2/explain`]: {},
      [`GET ${repo}/evaluations/e-2/explain?runId=batch-1&taskId=t-1&harness=codex`]: {
        available: false,
        running: false,
        reason: "Its last explanation just ended without one.",
      },
    }),
  ).rejects.toThrow("gave no answer: Its last explanation just ended without one.");
});

test("results print each configuration's blocked count beside its pass rate", async () => {
  process.env.SELFBENCH_API_URL = "http://selfbench.test";
  process.env.SELFBENCH_API_KEY = "sbk_test";
  const report = {
    tasks: 2,
    configurations: [
      {
        key: "a",
        name: "Claude Opus",
        model: "anthropic/opus",
        harness: "pi",
        reasoning: "high",
        scored: 89,
        passed: 60,
        blocked: 7,
        passRate: 67.4,
      },
    ],
    taskResults: [],
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
  ) => {
    expect(String(input)).toContain(`${repo}/evaluations/results`);
    return Response.json(report);
  }) as typeof fetch);
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  // A terminal gets the table; piped output gets JSON.
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    await runCli(["results", "--repo", "acme/app"]);
    const printed = String(log.mock.calls.at(-1)?.[0]);
    expect(printed).toMatch(/PASSED\s+BLOCKED\s+COST/);
    expect(printed).toMatch(/60\/89\s+7\/89/);
  } finally {
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    log.mockRestore();
    fetchSpy.mockRestore();
  }
});
