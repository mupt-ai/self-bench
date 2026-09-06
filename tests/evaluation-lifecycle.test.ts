import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { createEvaluationActivities } from "../src/evaluation/activities.js";
import { HARBOR_VERSION } from "../src/evaluation/config.js";
import { executeEvaluation } from "../src/evaluation/runner.js";
import { getEvaluation, initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { runCommand } from "../src/process.js";
import { evaluationEnv, evaluationInput } from "./support/evaluation-fixture.js";

test("multiple tasks and harnesses run once each; a zero score still completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-matrix-"));
  try {
    const store = new LocalArtifactStore(join(root, "store"));
    const input = evaluationInput();
    input.harnesses = ["codex", "pi"];
    input.tasks.push({ runId: "run-one", taskId: "task-two", bundleKey: "tasks/task.tar.gz" });
    await mkdir(join(root, "task"));
    await writeFile(join(root, "task", "task.toml"), 'version = "1.0"');
    await runCommand("tar", [
      "-czf",
      join(root, "bundle.tar.gz"),
      "-C",
      join(root, "task"),
      "task.toml",
    ]);
    await store.put(
      "tasks/task.tar.gz",
      await readFile(join(root, "bundle.tar.gz")),
      "application/gzip",
    );
    await saveEvaluation(store, initialEvaluation(input, "Test"));
    const calls: string[] = [];
    await executeEvaluation(store, input, {
      env: evaluationEnv,
      command: async (_name, args) => {
        if (args[0] === "--version") return { exitCode: 0, stdout: HARBOR_VERSION, stderr: "" };
        const jobs = args[args.indexOf("--jobs-dir") + 1];
        const harness = args[args.indexOf("--agent") + 1];
        if (!jobs || !harness) throw new Error("Bad solver args");
        calls.push(harness);
        const trial = join(jobs, "solver", "trial-one");
        await mkdir(trial, { recursive: true });
        await writeFile(
          join(trial, "result.json"),
          JSON.stringify({ verifier_result: { rewards: { reward: 0 } } }),
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual(["codex", "pi", "codex", "pi"]);
    const run = await getEvaluation(store, input.repoId, input.id);
    expect(run?.status).toBe("completed");
    expect(run?.trials.map((trial) => trial.rewards.reward)).toEqual([0, 0, 0, 0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("worker interruption finalizes persisted progress without rerunning the solver", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-interrupted-"));
  try {
    const store = new LocalArtifactStore(root);
    const input = evaluationInput();
    const run = initialEvaluation(input, "Test");
    run.status = "running";
    if (run.trials[0]) run.trials[0].status = "running";
    await saveEvaluation(store, run);
    const activities = createEvaluationActivities(store);
    await activities.failSolverEvaluation(input);
    const failed = await getEvaluation(store, input.repoId, input.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("cleanup");
    expect(failed?.trials[0]?.status).toBe("failed");
    const revision = failed?.revision;
    await activities.failSolverEvaluation(input);
    expect((await getEvaluation(store, input.repoId, input.id))?.revision).toBe(revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("an already-cancelled evaluation does not invoke a solver", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-cancelled-"));
  try {
    const store = new LocalArtifactStore(root);
    const input = evaluationInput();
    await saveEvaluation(store, initialEvaluation(input, "Test"));
    const controller = new AbortController();
    controller.abort();
    const calls: string[][] = [];
    await executeEvaluation(store, input, {
      env: evaluationEnv,
      signal: controller.signal,
      command: async (_name, args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: HARBOR_VERSION, stderr: "" };
      },
    });
    expect(calls.every((args) => args[0] === "--version")).toBe(true);
    expect((await getEvaluation(store, input.repoId, input.id))?.status).toBe("failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
