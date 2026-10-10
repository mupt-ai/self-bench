import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { explainTrialFailure } from "../src/evaluation/failure-summary.js";
import { getEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput, EvaluationTrial } from "../src/evaluation/types.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import type { CommandOptions, CommandResult } from "../src/lib/process.js";
import { testModelSecret } from "./support/evaluation-fixture.js";
import { runEvaluation } from "./support/evaluation-run.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

const PLATFORM_KEY = "sk-or-platform-key-never-publish";
const MANAGED = {
  PATH: "/usr/bin:/bin",
  SELFBENCH_MANAGED_OFFERING: "true",
  SELFBENCH_MANAGED_OPENROUTER_API_KEY: PLATFORM_KEY,
  DATABASE_URL: "postgres://worker:db-password@db/selfbench",
};
const TASK_FILES = {
  "instruction.md": "Order the chunks by path.\n",
  "tests/test.patch": "+test('chunks are ordered by path', ...)\n",
  "solution/gold.patch": "+chunks.sort(byPath)\n",
};

interface PiCall {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  material: string;
  /** The trial as saved when Pi started. */
  saved?: EvaluationTrial;
}

/** Harbor scoring `reward`, then Pi answering with `pi` when the runner asks it. */
async function evaluate(
  env: NodeJS.ProcessEnv,
  reward: number,
  pi: CommandResult = { stdout: "", stderr: "", exitCode: 0 },
  explainFailures = true,
) {
  const consent = (input: EvaluationInput) => {
    if (explainFailures) input.explainFailures = true;
  };
  const { store, input, vault } = await runnerFixture(undefined, consent, TASK_FILES);
  const calls: PiCall[] = [];
  const command = async (name: string, args: readonly string[], options?: CommandOptions) => {
    if (name === process.execPath) {
      const material = args.find((arg) => arg.startsWith("@"))?.slice(1) ?? "";
      const saved = (await getEvaluation(store, input.repoId, input.id))?.trials[0];
      calls.push({
        args,
        env: options?.env ?? {},
        material: await readFile(material, "utf8"),
        ...(saved ? { saved } : {}),
      });
      return pi;
    }
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    const trial = join(args[args.indexOf("--jobs-dir") + 1] ?? "", "solver", "task__123");
    await mkdir(join(trial, "verifier"), { recursive: true });
    await mkdir(join(trial, "artifacts", "opt", "selfbench"), { recursive: true });
    await writeFile(
      join(trial, "verifier", "test-stdout.txt"),
      `FAIL chunks are ordered by path: expected [a, b], got [b, a]\n${testModelSecret}\n`,
    );
    await writeFile(
      join(trial, "artifacts", "opt", "selfbench", "agent.patch"),
      "+chunks.reverse()\n",
    );
    await mkdir(join(trial, "agent"), { recursive: true });
    await writeFile(join(trial, "agent", "trajectory.json"), JSON.stringify(TRAJECTORY));
    await writeFile(
      join(trial, "result.json"),
      JSON.stringify({ verifier_result: { rewards: { reward } }, exception_info: null }),
    );
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await runEvaluation(store, input, { env, vault, command, pollMs: 5, progressMs: 0 });
  const trial = (await getEvaluation(store, input.repoId, input.id))?.trials[0];
  return { trial, calls, store, input, command };
}

/** The solver's transcript: one edit, the only trace of its changes once Harbor's run is gone. */
const TRAJECTORY = {
  steps: [
    {
      step_id: 1,
      source: "agent",
      message: "Reversing the chunks.",
      tool_calls: [
        {
          tool_call_id: "edit-1",
          function_name: "edit",
          arguments: { path: "chunks.ts", replace: "chunks.reverse()" },
        },
      ],
      observation: { results: [{ source_call_id: "edit-1", content: "Edited chunks.ts" }] },
    },
  ],
};

const LUNA: CommandResult = {
  stdout: `The agent reversed the chunks instead of sorting them by path. ${PLATFORM_KEY}\n`,
  stderr: "",
  exitCode: 0,
};

test("a trial that fails its tests is explained by Pi running GPT-6 Luna on the platform key", async () => {
  const { trial, calls } = await evaluate(MANAGED, 0, LUNA);
  expect(trial?.status).toBe("completed");
  expect(trial?.failureSummary).toEqual({
    text: "The agent reversed the chunks instead of sorting them by path. [redacted]",
    model: "gpt-6-luna",
  });
  const [call] = calls;
  if (!call) throw new Error("Pi was not run");
  // The scored result is saved before Pi starts, so a lost worker never loses it.
  expect(call.saved).toMatchObject({ status: "completed", rewards: { reward: 0 } });
  expect(call.saved?.finishedAt).toBeString();
  const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
  expect([flag("--provider"), flag("--model"), flag("--thinking")]).toEqual([
    "openrouter",
    "openai/gpt-6-luna",
    "high",
  ]);
  expect(call.args).toContain("--no-tools");
  // Pi sees the platform key and nothing else of the worker's environment.
  expect(call.env).toEqual({
    PATH: MANAGED.PATH,
    HOME: expect.any(String),
    LANG: "C.UTF-8",
    OPENROUTER_API_KEY: PLATFORM_KEY,
  });
  for (const evidence of [
    "Order the chunks by path.",
    "expected [a, b], got [b, a]",
    "chunks are ordered by path",
    "+chunks.reverse()",
    "+chunks.sort(byPath)",
  ])
    expect(call.material).toContain(evidence);
  expect(call.material).not.toContain(testModelSecret);
});

test("a summary never holds up or changes a trial's result", async () => {
  const cases = [
    { name: "a passing trial", env: MANAGED, reward: 1, runs: 0 },
    { name: "no platform key", env: { PATH: MANAGED.PATH }, reward: 0, runs: 0 },
    // A private repository on the organization's own key never sends its code to SelfBench's.
    { name: "a private repository", env: MANAGED, reward: 0, runs: 0, explain: false },
    {
      name: "a malformed offering switch",
      env: { ...MANAGED, SELFBENCH_MANAGED_OFFERING: "TRUE" },
      reward: 0,
      runs: 0,
    },
    {
      name: "Pi failing",
      env: MANAGED,
      reward: 0,
      runs: 1,
      pi: { stdout: "", stderr: "401 unauthorized", exitCode: 1 },
    },
  ];
  for (const entry of cases) {
    const { trial, calls } = await evaluate(entry.env, entry.reward, entry.pi, entry.explain);
    expect({ name: entry.name, runs: calls.length, status: trial?.status }).toEqual({
      name: entry.name,
      runs: entry.runs,
      status: "completed",
    });
    expect(trial?.rewards.reward).toBe(entry.reward);
    expect(trial?.failureSummary).toBeUndefined();
  }
});

test("Explain Failure explains a trial that kept no material from what its evaluation stored", async () => {
  // Run without consent, as every trial before this feature did: nothing kept, Pi never asked.
  const { calls, store, input, command } = await evaluate(MANAGED, 0, LUNA, false);
  expect(calls).toHaveLength(0);
  const request = { repoId: input.repoId, id: input.id, index: 0 };
  const bundleKey = input.tasks[0]?.bundleKey ?? "";
  const redact = (text: string) => text.split(PLATFORM_KEY).join("[redacted]");
  await explainTrialFailure(store, { ...request, bundleKey }, { command, env: MANAGED, redact });
  const [call] = calls;
  if (!call) throw new Error("Pi was not run");
  for (const evidence of [
    "Order the chunks by path.",
    "expected [a, b], got [b, a]",
    "chunks are ordered by path",
    "+chunks.sort(byPath)",
    "chunks.reverse()",
  ])
    expect(call.material).toContain(evidence);
  // The diff only Harbor's run held is not claimed to be empty.
  expect(call.material).not.toContain("changed no files");
  const trial = (await getEvaluation(store, input.repoId, input.id))?.trials[0];
  expect(trial?.failureSummary?.text).toStartWith("The agent reversed the chunks");
  // Asked again, an explained trial is left as it is.
  await explainTrialFailure(store, { ...request, bundleKey }, { command, env: MANAGED, redact });
  expect(calls).toHaveLength(1);
});
