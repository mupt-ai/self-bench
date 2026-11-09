import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cyberBlocked } from "../src/evaluation/output.js";
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
  const run = await getEvaluation(store, input, input.id);
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
  const trial = (await getEvaluation(store, input, input.id))?.trials[0];
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
    return (await getEvaluation(store, input, input.id))?.trials[0];
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
test("tests that run past their time limit fail the trial instead of erroring it", async () => {
  const { store, input, vault } = await runnerFixture(undefined, (input) => {
    input.harnesses = ["pi"];
  });
  const command: typeof runCommand = async (_name, args) => {
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    const trial = join(args[args.indexOf("--jobs-dir") + 1] ?? "", "solver", "task__123");
    await mkdir(join(trial, "agent"), { recursive: true });
    await writeFile(
      join(trial, "agent", "pi.txt"),
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "openai",
          model: "test-model",
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        },
      })}\n`,
    );
    // Harbor's result when the verifier hangs: no scores, only its timeout.
    await writeFile(
      join(trial, "result.json"),
      JSON.stringify({
        verifier_result: null,
        exception_info: {
          exception_type: "VerifierTimeoutError",
          exception_message: "Verifier execution timed out after 1800.0 seconds",
        },
      }),
    );
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await runEvaluation(store, input, { env: {}, vault, command, pollMs: 5, progressMs: 0 });
  const trial = (await getEvaluation(store, input, input.id))?.trials[0];
  expect(trial).toMatchObject({
    status: "completed",
    verifierTimedOut: true,
    rewards: { reward: 0 },
    modelVerified: true,
  });
  expect(trial?.error).toBeUndefined();
});
/** Pi's last reply, as a model error. */
const piError = (errorMessage: string) =>
  `${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-model",
      stopReason: "error",
      errorMessage,
    },
  })}\n`;
test("a provider's cyber block scores the trial 0, counted apart from its other failures", async () => {
  const block = "Cyber safeguards flagged this message. Rephrase the request.";
  // Anthropic's block reaches the trial through Pi's last reply.
  const piBlocked = await runHarnessTrial("pi", { verifier_result: null, exception_info: null }, [
    ["agent/pi.txt", piError(block)],
  ]);
  expect(piBlocked).toMatchObject({
    status: "completed",
    rewards: { reward: 0 },
    cyberBlocked: true,
  });
  expect(piBlocked?.error).toBe(`Pi stopped on a model error: ${block}`);
  // OpenAI's block reaches Codex's trial as Harbor's exception.
  const codexBlocked = await runHarnessTrial("codex", {
    verifier_result: null,
    exception_info: {
      exception_type: "NonZeroAgentExitCodeError",
      exception_message:
        "Codex error: This content was flagged for possible cybersecurity risk. Learn more.",
    },
  });
  expect(codexBlocked).toMatchObject({
    status: "completed",
    rewards: { reward: 0 },
    cyberBlocked: true,
  });
});
test("other failures stay failed and unscored, even when the model or sandbox is at fault", async () => {
  const rateLimited = await runHarnessTrial("pi", { verifier_result: null, exception_info: null }, [
    ["agent/pi.txt", piError("429 Too Many Requests: rate limit exceeded")],
  ]);
  const imageFailed = await runHarnessTrial("codex", {
    verifier_result: null,
    exception_info: {
      exception_type: "EnvironmentStartTimeoutError",
      exception_message: "E2B image build failed: out of memory",
    },
  });
  for (const trial of [rateLimited, imageFailed]) {
    expect(trial).toMatchObject({ status: "failed", rewards: {} });
    expect(trial?.cyberBlocked).toBeUndefined();
  }
});
test("an ordinary wrong answer is still a completed failure, not a blocked one", async () => {
  const wrong = await runHarnessTrial("pi", {
    verifier_result: { rewards: { reward: 0 } },
    exception_info: null,
  });
  expect(wrong).toMatchObject({ status: "completed", rewards: { reward: 0 } });
  expect(wrong?.cyberBlocked).toBeUndefined();
  expect(wrong?.error).toBeUndefined();
});
test("only the provider's cyber classifier messages count as blocks", () => {
  expect(cyberBlocked("Pi stopped on a model error: Cyber safeguards flagged this message.")).toBe(
    true,
  );
  expect(cyberBlocked("Codex error: flagged for possible cybersecurity risk")).toBe(true);
  expect(cyberBlocked("Cyber safeguards are enabled for this workspace")).toBe(false);
  expect(cyberBlocked("API Error: 502 Bad Gateway")).toBe(false);
});

/**
 * Runs one trial of a harness whose Harbor result and output files are given, returning the saved
 * trial. `files` are written beside Harbor's result, by relative path under the trial's folder.
 */
async function runHarnessTrial(
  harness: "pi" | "codex",
  harbor: Record<string, unknown>,
  files: [string, string][] = [],
) {
  const { store, input, vault } = await runnerFixture(undefined, (input) => {
    input.harnesses = [harness];
  });
  const command: typeof runCommand = async (_name, args) => {
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    const trial = join(args[args.indexOf("--jobs-dir") + 1] ?? "", "solver", "task__123");
    await mkdir(join(trial, "agent"), { recursive: true });
    for (const [name, text] of files) await writeFile(join(trial, name), text);
    await writeFile(join(trial, "result.json"), JSON.stringify(harbor));
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await runEvaluation(store, input, { env: {}, vault, command, pollMs: 5, progressMs: 0 });
  return (await getEvaluation(store, input, input.id))?.trials[0];
}
