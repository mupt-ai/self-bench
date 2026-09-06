import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { evaluationChoices, HARBOR_VERSION, solverEnvironment } from "../src/evaluation/config.js";
import {
  collectOutput,
  completeLines,
  piSteps,
  redactOutput,
  trajectorySteps,
} from "../src/evaluation/output.js";
import { executeEvaluation, solverArguments } from "../src/evaluation/runner.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  listEvaluations,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { runCommand } from "../src/process.js";
import { evaluationEnv, evaluationInput } from "./support/evaluation-fixture.js";

const directories: string[] = [];
test("E2B uses the packaged one-hour Harbor environment adapter", () => {
  const args = solverArguments("/task", "/jobs", "codex", "openai/test", "e2b");
  expect(args[args.indexOf("--env") + 1]).toBe("harbor_e2b:SelfBenchE2BEnvironment");
});
test("solver invocation carries the selected thinking level", () => {
  const args = solverArguments("/task", "/jobs", "codex", "openai/gpt-6-astra", "e2b", "max");
  expect(args.slice(-2)).toEqual(["--agent-kwarg", "reasoning_effort=max"]);
  expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-6-astra");
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-"));
  directories.push(root);
  const task = join(root, "task", "harbor-task");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "task.toml"), 'version = "1.0"');
  await runCommand("tar", [
    "-czf",
    join(root, "task.tar.gz"),
    "-C",
    join(root, "task"),
    "harbor-task",
  ]);
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const input = evaluationInput();
  await store.put(
    input.tasks[0]?.bundleKey ?? "",
    await readFile(join(root, "task.tar.gz")),
    "application/gzip",
  );
  await saveEvaluation(store, initialEvaluation(input, "Test model"));
  return { root, store, input };
}
const trajectory = {
  steps: [
    {
      step_id: 1,
      source: "agent",
      message: "Fixed the parser",
      tool_calls: [
        { tool_call_id: "call-1", function_name: "exec", arguments: { command: "bun test" } },
      ],
      observation: { results: [{ source_call_id: "call-1", content: "2 tests passed" }] },
    },
  ],
};
test("only configured, tenant-allowed choices are public; credentials and host auth are isolated", () => {
  expect(evaluationChoices("outsider", evaluationEnv).models).toHaveLength(0);
  expect(evaluationChoices("avyay", {}).models).toHaveLength(0);
  const { child } = solverEnvironment(evaluationInput(), "/temporary-home", {
    ...evaluationEnv,
    PATH: "/bin",
    HOME: "/real-home",
    GITHUB_TOKEN: "github",
    DATABASE_URL: "postgres-secret",
    ANTHROPIC_API_KEY: "other-provider",
    E2B_API_KEY: "e2b",
    VERCEL_TOKEN: "vercel",
    MODAL_TOKEN_SECRET: "modal",
  });
  expect(child).toEqual({
    PATH: "/bin",
    HOME: "/temporary-home",
    TMPDIR: "/temporary-home",
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    OPENAI_API_KEY: evaluationEnv.SELFBENCH_EVAL_SECRET_TEST,
  });
  expect(() =>
    solverEnvironment(evaluationInput(), "/tmp", {
      ...evaluationEnv,
      SELFBENCH_EVAL_SECRET_TEST: "",
    }),
  ).toThrow("credential");
  expect(() =>
    solverEnvironment({ ...evaluationInput(), sandbox: "modal" }, "/tmp", evaluationEnv),
  ).toThrow("Modal credentials");
});
test("solver argv cannot trigger author/oracle gates or implicit retries", () => {
  const args = solverArguments("/task space", "/jobs", "codex", "openai/test-model", "docker");
  expect(args).toContain("/task space");
  expect(args.slice(args.indexOf("--max-retries"), args.indexOf("--max-retries") + 2)).toEqual([
    "--max-retries",
    "0",
  ]);
  expect(args).not.toContain("oracle");
  expect(args).not.toContain("nop");
});
test("mocked Harbor persists live output, structured tool results and final scores without secrets", async () => {
  const { store, input } = await fixture();
  let calls = 0;
  let sawLive = false;
  const command: typeof runCommand = async (name, args, options) => {
    expect(name).toBe("harbor");
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    calls += 1;
    const jobs = args[args.indexOf("--jobs-dir") + 1];
    if (!jobs) throw new Error("Missing jobs path");
    const trial = join(jobs, "solver", "task__123");
    await mkdir(join(trial, "agent"), { recursive: true });
    await writeFile(
      join(trial, "agent", "codex.txt"),
      `Running tests\n${evaluationEnv.SELFBENCH_EVAL_SECRET_TEST}\n`,
    );
    options?.onOutput?.(
      "stdout",
      Buffer.from(`Starting ${evaluationEnv.SELFBENCH_EVAL_SECRET_TEST}\n`),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = await getEvaluation(store, input.repoId, input.id);
      if (snapshot?.trials[0]?.log.includes("Running tests")) {
        sawLive = true;
        expect(JSON.stringify(snapshot)).not.toContain(evaluationEnv.SELFBENCH_EVAL_SECRET_TEST);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await writeFile(join(trial, "agent", "trajectory.json"), JSON.stringify(trajectory));
    await writeFile(
      join(trial, "result.json"),
      JSON.stringify({ verifier_result: { rewards: { reward: 1 } }, exception_info: null }),
    );
    await writeFile(join(trial, "config.json"), '{"secret":"never-export-this"}');
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await executeEvaluation(store, input, { env: evaluationEnv, command, pollMs: 5 });
  const run = await getEvaluation(store, input.repoId, input.id);
  expect(sawLive).toBe(true);
  expect(run?.status).toBe("completed");
  expect(run?.trials[0]?.rewards).toEqual({ reward: 1 });
  expect(run?.trials[0]?.steps[0]?.tools[0]?.output).toBe("2 tests passed");
  expect(run?.trials[0]?.artifacts.some((name) => name.endsWith("config.json"))).toBe(false);
  for (const artifact of await store.list(evaluationPrefix(input.repoId, input.id).slice(0, -1)))
    expect(Buffer.from((await store.getByKey(artifact.key)) ?? []).toString()).not.toContain(
      evaluationEnv.SELFBENCH_EVAL_SECRET_TEST,
    );
  expect((await listEvaluations(store, input.repoId))[0]?.status).toBe("completed");
  await expect(executeEvaluation(store, input, { env: evaluationEnv, command })).rejects.toThrow(
    "refusing to repeat",
  );
  expect(calls).toBe(1);
});
test("missing credentials and incompatible Harbor fail before a model command", async () => {
  for (const scenario of ["credential", "version"]) {
    const { store, input } = await fixture();
    let calls = 0;
    await executeEvaluation(store, input, {
      env:
        scenario === "credential"
          ? { ...evaluationEnv, SELFBENCH_EVAL_SECRET_TEST: "" }
          : evaluationEnv,
      command: async (_name, args) => {
        if (args[0] !== "--version") calls += 1;
        return { stdout: "wrong-version", stderr: "", exitCode: 0 };
      },
    });
    expect((await getEvaluation(store, input.repoId, input.id))?.status).toBe("failed");
    expect(calls).toBe(0);
  }
});
test("missing verifier results are failures, never invented zero scores", async () => {
  const { store, input } = await fixture();
  await executeEvaluation(store, input, {
    env: evaluationEnv,
    command: async (_name, args) => ({
      stdout: args[0] === "--version" ? HARBOR_VERSION : "",
      stderr: "",
      exitCode: 0,
    }),
  });
  const run = await getEvaluation(store, input.repoId, input.id);
  expect(run?.status).toBe("failed");
  expect(run?.trials[0]?.error).toContain("trial result");
  expect(run?.trials[0]?.rewards).toEqual({});
});
test("output collector excludes symlinks, credential files and arbitrary artifacts", async () => {
  const { root } = await fixture();
  const logs = join(root, "logs");
  await mkdir(logs);
  await writeFile(join(root, "secret.txt"), "private");
  await symlink(join(root, "secret.txt"), join(logs, "codex.txt"));
  await writeFile(join(logs, "auth.json"), "private");
  await symlink(root, join(logs, "nested"));
  expect((await collectOutput(logs)).size).toBe(0);
});
test("ATIF and Pi tool calls retain the matching tool output", () => {
  expect(trajectorySteps(trajectory)[0]?.tools[0]).toMatchObject({
    id: "call-1",
    output: "2 tests passed",
  });
  const events = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Testing" },
          { type: "toolCall", id: "first", name: "bash", arguments: { command: "test" } },
        ],
      },
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "first",
        toolName: "bash",
        content: [{ type: "text", text: "Passed" }],
      },
    },
  ];
  expect(
    piSteps(events.map((event) => JSON.stringify(event)).join("\n"))[0]?.tools[0]?.output,
  ).toBe("Passed");
  expect(completeLines("safe\npartial-secret")).toBe("safe\n");
  expect(redactOutput("Bearer abcd xyz-secret", ["xyz-secret"])).toBe(
    "Bearer [redacted] [redacted]",
  );
});
