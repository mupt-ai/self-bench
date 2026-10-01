import { expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { credentialExecution, solverArguments } from "../src/evaluation/execution.js";
import {
  collectOutput,
  completeLines,
  piSteps,
  redactOutput,
  trajectorySteps,
} from "../src/evaluation/output.js";
import { evaluationPrefix, getEvaluation, listEvaluations } from "../src/evaluation/store.js";
import {
  assertEvaluationBundleSize,
  MAX_EVALUATION_BUNDLE_BYTES,
} from "../src/evaluation/task-bundle.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import type { runCommand } from "../src/lib/process.js";
import { testModelSecret } from "./support/evaluation-fixture.js";
import { runEvaluation } from "./support/evaluation-run.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

test("PostHog-sized bundles pass the compressed size guard, but oversized bundles do not", () => {
  expect(() => assertEvaluationBundleSize(373_934_442)).not.toThrow();
  expect(() => assertEvaluationBundleSize(MAX_EVALUATION_BUNDLE_BYTES + 1)).toThrow(
    "Task bundle exceeds 512 MiB",
  );
});
test("solver invocation carries the selected thinking level", () => {
  const args = solverArguments("/task", "/jobs", "codex", "openai/gpt-6-astra", "e2b", "max");
  expect(args.slice(-2)).toEqual(["--agent-kwarg", "reasoning_effort=max"]);
  expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-6-astra");
});
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
test("saved credentials reach the solver; host auth never does", async () => {
  const { input, vault } = await runnerFixture();
  const { child } = await credentialExecution(
    input,
    "/temporary-home",
    {
      PATH: "/bin",
      HOME: "/real-home",
      GITHUB_TOKEN: "github",
      DATABASE_URL: "postgres-secret",
      ANTHROPIC_API_KEY: "other-provider",
      E2B_API_KEY: "e2b",
      VERCEL_TOKEN: "vercel",
      MODAL_TOKEN_SECRET: "modal",
    },
    vault,
  );
  expect(child).toEqual({
    PATH: "/bin",
    HOME: "/temporary-home",
    TMPDIR: "/temporary-home",
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    OPENAI_API_KEY: testModelSecret,
    E2B_API_KEY: "sandbox-secret",
  });
  await expect(
    credentialExecution({ ...input, sandbox: "modal" }, "/tmp", {}, vault),
  ).rejects.toThrow("reserved comparison");
  const foreign = { runId: "run-one", taskId: "not-reserved", bundleKey: "tasks/other.tar.gz" };
  await expect(
    credentialExecution({ ...input, tasks: [foreign] }, "/tmp", {}, vault),
  ).rejects.toThrow("reserved comparison");
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
  const { store, input, vault } = await runnerFixture();
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
    await writeFile(join(trial, "agent", "codex.txt"), '{"type":"item.completed"}\n');
    await writeFile(join(trial, "trial.log"), `Running tests\n${testModelSecret}\n`);
    options?.onOutput?.("stdout", Buffer.from(`Starting ${testModelSecret}\n`));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = await getEvaluation(store, input.repoId, input.id);
      if (snapshot?.trials[0]?.log.includes("Running tests")) {
        sawLive = true;
        expect(JSON.stringify(snapshot)).not.toContain(testModelSecret);
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
  await runEvaluation(store, input, { env: {}, vault, command, pollMs: 5, progressMs: 0 });
  const run = await getEvaluation(store, input.repoId, input.id);
  expect(sawLive).toBe(true);
  expect(run?.status).toBe("completed");
  expect(run?.trials[0]?.rewards).toEqual({ reward: 1 });
  expect(run?.trials[0]?.steps[0]?.tools[0]?.output).toBe("2 tests passed");
  // The transcript is shown as steps, not repeated in the log; Harbor's stdout appears once.
  expect(run?.trials[0]?.log).not.toContain("item.completed");
  expect(run?.trials[0]?.log.match(/Starting/g)).toHaveLength(1);
  expect(run?.trials[0]?.artifacts.some((name) => name.endsWith("config.json"))).toBe(false);
  for (const artifact of await store.list(evaluationPrefix(input.repoId, input.id).slice(0, -1)))
    expect(Buffer.from((await store.getByKey(artifact.key)) ?? []).toString()).not.toContain(
      testModelSecret,
    );
  expect((await listEvaluations(store, input.repoId))[0]?.status).toBe("completed");
  await expect(runEvaluation(store, input, { env: {}, vault, command })).rejects.toThrow(
    "refusing to repeat",
  );
  expect(calls).toBe(1);
});
test("setup failures a retry cannot fix fail the trial at once, before a model command", async () => {
  for (const [scenario, version, error] of [
    // The Harbor version is right here, so only the missing credential can stop the run.
    ["credential", HARBOR_VERSION, "Credential unavailable"],
    ["version", "wrong-version", "does not match supported"],
    ["bundle", HARBOR_VERSION, "Task bundle is missing"],
  ] as const) {
    const { root, store, input, vault } = await runnerFixture();
    if (scenario === "credential")
      await vault.credentials.remove(1, input.credentials?.modelCredentialId ?? "");
    if (scenario === "bundle") await rm(join(root, "artifacts", input.tasks[0]?.bundleKey ?? ""));
    let calls = 0;
    // Retries remain, so a failure returned to the queue would end as a generic interruption.
    await runEvaluation(store, input, {
      env: {},
      vault,
      retry: true,
      command: async (_name, args) => {
        if (args[0] !== "--version") calls += 1;
        return { stdout: version, stderr: "", exitCode: 0 };
      },
    });
    const run = await getEvaluation(store, input.repoId, input.id);
    expect(run?.status).toBe("failed");
    expect(run?.trials[0]?.error).toContain(error);
    expect(calls).toBe(0);
  }
});
test("missing verifier results are failures, never invented zero scores", async () => {
  const { store, input, vault } = await runnerFixture();
  // Once Harbor has run, the trial is never retried, though attempts remain.
  await runEvaluation(store, input, {
    env: {},
    vault,
    retry: true,
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
test("a bundle that asks for host credentials fails its trial before Harbor runs", async () => {
  const { store, input, vault } = await runnerFixture(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: exercises Harbor's host interpolation.
    '[verifier.env]\nKEY = "${OPENAI_API_KEY}"\n',
  );
  let calls = 0;
  await runEvaluation(store, input, {
    env: {},
    vault,
    command: async (_name, args) => {
      if (args[0] !== "--version") calls += 1;
      return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    },
  });
  const run = await getEvaluation(store, input.repoId, input.id);
  expect(run?.trials[0]?.status).toBe("failed");
  expect(run?.trials[0]?.error).toContain("task.toml sets verifier.env");
  expect(calls).toBe(0);
});
test("output collector excludes symlinks, credential files and arbitrary artifacts", async () => {
  const { root } = await runnerFixture();
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
