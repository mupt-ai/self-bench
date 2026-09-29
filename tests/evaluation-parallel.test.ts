import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetryState } from "@temporalio/common";
import { CancelledFailure, ChildWorkflowFailure, TerminatedFailure } from "@temporalio/workflow";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { failTrial, finishEvaluation, startEvaluation } from "../src/evaluation/lifecycle.js";
import { executeTrial } from "../src/evaluation/runner.js";
import { getEvaluation } from "../src/evaluation/store.js";
import { trialInput } from "../src/evaluation/trial-input.js";
import { runEvaluationTrials, runTrial } from "../src/evaluation/workflow.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import { CommandTimeoutError, runCommand } from "../src/lib/process.js";
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
  // Each trial workflow carries only its own task.
  await Promise.all(
    [0, 1, 2, 3].map((index) => executeTrial(store, trialInput(input, index), index, options)),
  );
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

test("a trial whose setup failed before Harbor ran is retried, and its last attempt records why", async () => {
  const { store, vault, input } = await started();
  const { calls, command } = harbor();
  // A new worker's first `harbor --version` calls outlast their timeout.
  let timeouts = 1;
  const options = {
    env: {},
    vault,
    retry: true,
    command: (async (name, args, commandOptions) => {
      if (args[0] === "--version" && timeouts-- > 0)
        throw new CommandTimeoutError("harbor --version", 60_000);
      return command(name, args, commandOptions);
    }) satisfies typeof runCommand,
  };
  await expect(executeTrial(store, trialInput(input, 0), 0, options)).rejects.toThrow(
    "exceeded 60000ms",
  );
  expect((await getEvaluation(store, input.repoId, input.id))?.trials[0]?.status).toBe("queued");
  await executeTrial(store, trialInput(input, 0), 0, options);
  timeouts = 1;
  await executeTrial(store, trialInput(input, 1), 1, { ...options, retry: false });
  const trials = (await getEvaluation(store, input.repoId, input.id))?.trials;
  expect(trials?.slice(0, 2).map((trial) => trial.status)).toEqual(["completed", "failed"]);
  expect(trials?.[1]?.error).toBe("harbor --version exceeded 60000ms");
  expect(calls).toHaveLength(1);
});

test("a trial whose worker was lost before its solver started runs on the next attempt", async () => {
  const { store, vault, input } = await started();
  const { calls, command } = harbor();
  // The first attempt's worker stalls in setup (a preempted pod), so Temporal retries the trial.
  let resume = () => {};
  const stalled = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let reached = () => {};
  const setUp = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const lost = executeTrial(store, input, 0, {
    env: {},
    vault,
    command: (async (name, args, commandOptions) => {
      reached();
      await stalled;
      return command(name, args, commandOptions);
    }) satisfies typeof runCommand,
  });
  await setUp;
  await executeTrial(store, input, 0, { env: {}, vault, command });
  // A stalled attempt that comes back never starts Harbor or overwrites the outcome.
  resume();
  await expect(lost).rejects.toThrow("refusing to repeat model spend");
  expect(calls).toHaveLength(1);
  const trial = (await getEvaluation(store, input.repoId, input.id))?.trials[0];
  expect(trial?.status).toBe("completed");
  expect(trial?.solverStartedAt).toBeString();
});

test("a trial whose worker was lost after its solver started is not run again", async () => {
  const { store, vault, input } = await started();
  let reached = () => {};
  const solving = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { calls, command } = harbor(async () => {
    reached();
    await finished;
  });
  const first = executeTrial(store, input, 0, { env: {}, vault, command });
  await solving;
  await expect(executeTrial(store, input, 0, { env: {}, vault, command })).rejects.toThrow(
    "refusing to repeat model spend",
  );
  finish();
  await first;
  expect(calls).toHaveLength(1);
});

test("a stopping worker hands a trial in setup to the next attempt, but runs its last attempt", async () => {
  const { store, vault, input } = await started();
  const { calls, command } = harbor();
  // SIGTERM lands while the trial is in setup.
  const stopping = new AbortController();
  const options = {
    env: {},
    vault,
    retry: true,
    stopping: stopping.signal,
    command: (async (name, args, commandOptions) => {
      stopping.abort();
      return command(name, args, commandOptions);
    }) satisfies typeof runCommand,
  };
  await expect(executeTrial(store, input, 0, options)).rejects.toThrow(
    "Worker stopped before the solver started",
  );
  const trial = (await getEvaluation(store, input.repoId, input.id))?.trials[0];
  expect(trial?.status).toBe("queued");
  expect(trial?.claim).toBeUndefined();
  expect(calls).toHaveLength(0);
  await executeTrial(store, input, 0, { ...options, retry: false });
  expect((await getEvaluation(store, input.repoId, input.id))?.trials[0]?.status).toBe("completed");
});

test("a worker that stops once a solver has started leaves that solver running", async () => {
  const { store, vault, input } = await started();
  const { calls, command } = harbor();
  const stopping = new AbortController();
  let aborted: boolean | undefined;
  await executeTrial(store, input, 0, {
    env: {},
    vault,
    retry: true,
    stopping: stopping.signal,
    command: (async (name, args, commandOptions) => {
      if (args[0] !== "--version") {
        stopping.abort();
        aborted = commandOptions?.signal?.aborted;
      }
      return command(name, args, commandOptions);
    }) satisfies typeof runCommand,
  });
  expect(aborted).toBe(false);
  expect(calls).toHaveLength(1);
  expect((await getEvaluation(store, input.repoId, input.id))?.trials[0]?.status).toBe("completed");
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
    solve: (_input: unknown, index: number) => runSolverTrial(index),
  };
}

test("the workflow bounds trials in flight and fails only a trial whose activity failed", async () => {
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  const { events, records, solve } = workflowActivities(async (index) => {
    started.push(index);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    if (index === 1) throw new Error("Heartbeat timeout");
  });
  await runEvaluationTrials(evaluationInput(), records, solve, 2);
  expect(peak).toBe(2);
  expect(started.sort()).toEqual([0, 1, 2, 3, 4]);
  expect(events).toEqual(["fail 1", "finish"]);
});

test("a cancelled workflow waits for running trials and records no outcome", async () => {
  let settled = 0;
  const { events, records, solve } = workflowActivities(async (index) => {
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 1 : 20));
    settled += 1;
    throw new CancelledFailure("Activity cancelled");
  });
  await expect(runEvaluationTrials(evaluationInput(), records, solve, 3)).rejects.toThrow(
    "Activity cancelled",
  );
  expect(settled).toBe(3);
  expect(events).toEqual([]);
});

test("a trial workflow cancelled with its evaluation is not failed, but a terminated one is", async () => {
  const child = (cause: Error) =>
    new ChildWorkflowFailure(
      "default",
      { workflowId: "evaluation/1/run/trial/0" },
      "selfBenchSolverTrialWorkflow",
      RetryState.NON_RETRYABLE_FAILURE,
      cause,
    );
  const { events, records } = workflowActivities(async () => {});
  const cancelled = { runSolverTrial: () => Promise.reject(child(new CancelledFailure("x"))) };
  await expect(runTrial(evaluationInput(), 0, cancelled, records)).rejects.toThrow();
  const terminated = { runSolverTrial: () => Promise.reject(child(new TerminatedFailure("x"))) };
  await runTrial(evaluationInput(), 1, terminated, records);
  expect(events).toEqual(["fail 1"]);
});
