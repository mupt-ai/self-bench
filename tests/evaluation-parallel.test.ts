import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancelledFailure } from "@temporalio/workflow";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { failTrial, finishEvaluation, startEvaluation } from "../src/evaluation/lifecycle.js";
import { executeTrial } from "../src/evaluation/runner.js";
import { getEvaluation } from "../src/evaluation/store.js";
import { runEvaluationTrials } from "../src/evaluation/workflow.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import { runCommand } from "../src/lib/process.js";
import { credentialedInput, evaluationInput } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A started four-trial evaluation (two tasks, two harnesses) over one task bundle. */
async function started() {
  const root = await mkdtemp(join(tmpdir(), "evaluation-parallel-"));
  directories.push(root);
  await mkdir(join(root, "task"));
  await writeFile(join(root, "task", "task.toml"), 'version = "1.0"');
  await runCommand("tar", ["-czf", join(root, "task.tar.gz"), "-C", join(root, "task"), "."]);
  const store = new LocalArtifactStore(join(root, "store"));
  const vault = memoryVault();
  const input = await credentialedInput(vault, (value) => {
    value.harnesses = ["codex", "pi"];
    value.tasks.push({ runId: "run-one", taskId: "task-two", bundleKey: "tasks/task.tar.gz" });
    for (const task of value.tasks) task.bundleKey = "tasks/task.tar.gz";
  });
  await store.put(
    "tasks/task.tar.gz",
    await readFile(join(root, "task.tar.gz")),
    "application/gzip",
  );
  expect(await startEvaluation(store, input)).toBe(4);
  return { store, vault, input };
}

/** Harbor that scores each trial by its position, after `gate` lets it finish. */
function harbor(gate: () => Promise<void> = async () => {}) {
  const calls: string[] = [];
  const command: typeof runCommand = async (_name, args) => {
    if (args[0] === "--version") return { exitCode: 0, stdout: HARBOR_VERSION, stderr: "" };
    const jobs = args[args.indexOf("--jobs-dir") + 1] ?? "";
    calls.push(jobs);
    const trial = join(jobs, "solver", "trial-one");
    await mkdir(trial, { recursive: true });
    await writeFile(join(trial, "trial.log"), `Running ${calls.length}\n`);
    await gate();
    await writeFile(
      join(trial, "result.json"),
      JSON.stringify({ verifier_result: { rewards: { reward: calls.indexOf(jobs) } } }),
    );
    return { exitCode: 0, stdout: "", stderr: "", signal: null };
  };
  return { calls, command };
}

test("trials running at once each keep their own progress and result", async () => {
  const { store, vault, input } = await started();
  // Every trial is inside Harbor before any finishes, so their saves interleave.
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { calls, command } = harbor(async () => {
    if (calls.length === 4) release();
    await barrier;
  });
  const options = { env: {}, vault, command, pollMs: 1, progressMs: 0 };
  await Promise.all([0, 1, 2, 3].map((index) => executeTrial(store, input, index, options)));
  await finishEvaluation(store, input);
  const run = await getEvaluation(store, input.repoId, input.id);
  expect(run?.status).toBe("completed");
  expect(run?.trials.map((trial) => trial.status)).toEqual(Array(4).fill("completed"));
  expect(new Set(run?.trials.map((trial) => trial.rewards.reward))).toEqual(new Set([0, 1, 2, 3]));
  expect(run?.trials.every((trial) => trial.log.includes("Running"))).toBe(true);
});

test("a trial never runs Harbor twice, and a trial failed elsewhere stays failed", async () => {
  const { store, vault, input } = await started();
  let failedElsewhere = Promise.resolve();
  const { calls, command } = harbor(async () => {
    // The workflow gave up on this trial (a heartbeat timeout) while Harbor was still running.
    failedElsewhere = failTrial(store, input, 0);
    await failedElsewhere;
  });
  await executeTrial(store, input, 0, { env: {}, vault, command });
  await expect(executeTrial(store, input, 0, { env: {}, vault, command })).rejects.toThrow(
    "refusing to repeat model spend",
  );
  expect(calls).toHaveLength(1);
  const trial = (await getEvaluation(store, input.repoId, input.id))?.trials[0];
  expect(trial?.status).toBe("failed");
  expect(trial?.error).toContain("timed out");
  await expect(startEvaluation(store, input)).rejects.toThrow("refusing to repeat model spend");
});

function workflowActivities(runSolverTrial: (index: number) => Promise<void>) {
  const events: string[] = [];
  return {
    events,
    records: {
      startSolverEvaluation: async () => 5,
      failSolverTrial: async (_input: unknown, index: number) => {
        events.push(`fail ${index}`);
      },
      finishSolverEvaluation: async () => {
        events.push("finish");
      },
    },
    harbor: { runSolverTrial: (_input: unknown, index: number) => runSolverTrial(index) },
  };
}

test("the workflow bounds trials in flight and fails only a trial whose activity failed", async () => {
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  const { events, records, harbor } = workflowActivities(async (index) => {
    started.push(index);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    if (index === 1) throw new Error("Heartbeat timeout");
  });
  await runEvaluationTrials(evaluationInput(), records, harbor, 2);
  expect(peak).toBe(2);
  expect(started.sort()).toEqual([0, 1, 2, 3, 4]);
  expect(events).toEqual(["fail 1", "finish"]);
});

test("a cancelled workflow waits for running trials and records no outcome", async () => {
  let settled = 0;
  const { events, records, harbor } = workflowActivities(async (index) => {
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 1 : 20));
    settled += 1;
    throw new CancelledFailure("Activity cancelled");
  });
  await expect(runEvaluationTrials(evaluationInput(), records, harbor, 3)).rejects.toThrow(
    "Activity cancelled",
  );
  expect(settled).toBe(3);
  expect(events).toEqual([]);
});
