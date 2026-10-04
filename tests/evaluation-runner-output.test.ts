import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getEvaluation } from "../src/evaluation/store.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import type { runCommand } from "../src/lib/process.js";
import { runEvaluation } from "./support/evaluation-run.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

test("token usage comes from the whole transcript, though stored artifacts are cut", async () => {
  const { store, input, vault } = await runnerFixture();
  const step = { source: "agent", model_name: "test-model", message: "x".repeat(1024 * 1024) };
  const command: typeof runCommand = async (_name, args) => {
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    const trial = join(args[args.indexOf("--jobs-dir") + 1] ?? "", "solver", "task__123");
    await mkdir(join(trial, "agent"), { recursive: true });
    await writeFile(join(trial, "agent", "trajectory.json"), JSON.stringify({ steps: [step] }));
    const tokens = { n_input_tokens: 1000, n_cache_tokens: 200, n_output_tokens: 100 };
    await writeFile(
      join(trial, "result.json"),
      JSON.stringify({ agent_result: tokens, verifier_result: { rewards: { reward: 1 } } }),
    );
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await runEvaluation(store, input, { env: {}, vault, command, pollMs: 5, progressMs: 0 });
  const run = await getEvaluation(store, input.repoId, input.id);
  expect(run?.trials[0]).toMatchObject({
    modelVerified: true,
    tokenUsage: { input: 800, output: 100, cacheRead: 200, cacheWrite: 0 },
  });
});
test("a Pi run that ends on a model error fails, though Harbor scored its unfinished work", async () => {
  const { store, input, vault } = await runnerFixture(undefined, (input) => {
    input.harnesses = ["pi"];
  });
  const reply = (stopReason: string, errorMessage?: string) =>
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai",
        model: "test-model",
        stopReason,
        errorMessage,
      },
    });
  const command: typeof runCommand = async (_name, args) => {
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    const trial = join(args[args.indexOf("--jobs-dir") + 1] ?? "", "solver", "task__123");
    await mkdir(join(trial, "agent"), { recursive: true });
    const credits = "402: This request would exceed your available credits";
    await writeFile(
      join(trial, "agent", "pi.txt"),
      `${reply("toolUse")}\n${reply("error", credits)}\n`,
    );
    await writeFile(
      join(trial, "result.json"),
      JSON.stringify({ verifier_result: { rewards: { reward: 0 } }, exception_info: null }),
    );
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await runEvaluation(store, input, { env: {}, vault, command, pollMs: 5, progressMs: 0 });
  const trial = (await getEvaluation(store, input.repoId, input.id))?.trials[0];
  expect(trial?.status).toBe("failed");
  expect(trial?.error).toBe(
    "Pi stopped on a model error: 402: This request would exceed your available credits",
  );
});
test("an agent stopped at its time limit completes on Harbor's scores, or fails without any", async () => {
  const reply = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-model",
      stopReason: "toolUse",
      usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 },
    },
  });
  const timeout = {
    exception_type: "AgentTimeoutError",
    exception_message: "Agent execution timed out after 2400.0 seconds",
  };
  const trialFor = async (rewards: Record<string, number>) => {
    const { store, input, vault } = await runnerFixture(undefined, (input) => {
      input.harnesses = ["pi"];
    });
    const command: typeof runCommand = async (_name, args) => {
      if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
      const trial = join(args[args.indexOf("--jobs-dir") + 1] ?? "", "solver", "task__123");
      await mkdir(join(trial, "agent"), { recursive: true });
      // Pi was stopped mid-write: its last line is cut short.
      await writeFile(
        join(trial, "agent", "pi.txt"),
        `${reply}\n${reply}\n{"type":"turn_end","message":{"role":"assi`,
      );
      await writeFile(
        join(trial, "result.json"),
        JSON.stringify({ verifier_result: { rewards }, exception_info: timeout }),
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await runEvaluation(store, input, { env: {}, vault, command, pollMs: 5, progressMs: 0 });
    return (await getEvaluation(store, input.repoId, input.id))?.trials[0];
  };

  expect(await trialFor({ reward: 1 })).toMatchObject({
    status: "completed",
    agentTimedOut: true,
    rewards: { reward: 1 },
    modelVerified: true,
    tokenUsage: { input: 200, output: 20, cacheRead: 100, cacheWrite: 0 },
  });
  const unscored = await trialFor({});
  expect(unscored?.status).toBe("failed");
  expect(unscored?.error).toBe(timeout.exception_message);
  expect(unscored?.agentTimedOut).toBeUndefined();
});
