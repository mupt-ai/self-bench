import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/index.js";
import type { HarborEnvironment } from "../contracts/config/providers.js";
import type { ThinkingLevel } from "../contracts/models.js";
import type { Vault } from "../db/vault.js";
import {
  assertHarborVersion,
  HARBOR_PROCESS_TIMEOUT_MS,
  harborProcessEnvironment,
  harborRunArguments,
} from "../harnesses/harbor/command.js";
import type { HarborOutputGuard } from "../harnesses/harbor/output-guard.js";
import { prepareHarborRun } from "../harnesses/harbor/task-safety.js";
import { extractRegularArchive } from "../lib/archive.js";
import { runCommand } from "../lib/process.js";
import { trialCost } from "./cost.js";
import { credentialExecution, gatewayTrial, solverAgent } from "./execution.js";
import { thinkingArguments } from "./models.js";
import {
  boundedSteps,
  collectOutput,
  completeLines,
  piSteps,
  record,
  redactOutput,
  trajectorySteps,
  trialLog,
} from "./output.js";
import { evaluationPrefix, getEvaluation, saveEvaluation } from "./store.js";
import type { EvaluationInput, EvaluationRun, EvaluationTrial, Harness } from "./types.js";

// PostHog task bundles include compressed repository snapshots larger than 350 MiB.
// Keep a bounded compressed size; extractRegularArchive separately caps unpacked data.
export const MAX_EVALUATION_BUNDLE_BYTES = 512 * 1024 * 1024;

export function assertEvaluationBundleSize(size: number): void {
  if (size > MAX_EVALUATION_BUNDLE_BYTES) throw new Error("Task bundle exceeds 512 MiB");
}

export function solverArguments(
  taskPath: string,
  jobs: string,
  harness: Harness,
  model: string,
  sandbox: HarborEnvironment,
  thinking?: ThinkingLevel,
  extraAllowedHosts: readonly string[] = [],
): string[] {
  return harborRunArguments({
    taskPath,
    jobsPath: jobs,
    jobName: "solver",
    agent: solverAgent(harness, model),
    environment: sandbox,
    solver: { model, agentArguments: thinkingArguments(harness, thinking) },
    extraAllowedHosts,
  });
}
export interface RunnerOptions {
  command?: typeof runCommand;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  heartbeat?: () => void;
  pollMs?: number;
  vault?: Pick<Vault, "credentials" | "comparisons">;
}
export async function executeEvaluation(
  store: ArtifactStore,
  input: EvaluationInput,
  options: RunnerOptions = {},
): Promise<void> {
  const run = await getEvaluation(store, input.repoId, input.id);
  if (!run) throw new Error("Evaluation record is missing");
  if (run.status !== "queued")
    throw new Error("Evaluation already attempted; refusing to repeat model spend");
  const root = await mkdtemp(join(tmpdir(), "selfbench-evaluation-"));
  const command = options.command ?? runCommand;
  const environment = options.env ?? process.env;
  const secrets = Object.entries(environment)
    .filter(([name]) => /SECRET|TOKEN|PASSWORD|API_KEY/.test(name))
    .map(([, value]) => value ?? "")
    .filter(Boolean);
  const redact = (text: string) => redactOutput(text, secrets);
  run.status = "running";
  try {
    await saveEvaluation(store, run);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    if (!options.vault) throw new Error("Credential storage unavailable on the worker");
    const execution = await credentialExecution(input, home, environment, options.vault);
    secrets.push(...execution.secrets);
    const { profile } = execution;
    const child = harborProcessEnvironment(execution.child);
    const version = await command("harbor", ["--version"], { env: child, timeoutMs: 15_000 });
    assertHarborVersion(version.stdout);
    for (const [index, trial] of run.trials.entries()) {
      options.signal?.throwIfAborted();
      const task = input.tasks.find(
        (candidate) => candidate.runId === trial.runId && candidate.taskId === trial.taskId,
      );
      if (!task) throw new Error("Evaluation task snapshot is missing");
      const trialRoot = join(root, String(index));
      await mkdir(trialRoot);
      trial.status = "running";
      trial.startedAt = new Date().toISOString();
      await saveEvaluation(store, run);
      try {
        const bundle = await store.getByKey(task.bundleKey);
        if (!bundle) throw new Error("Task bundle is missing");
        assertEvaluationBundleSize(bundle.byteLength);
        const archive = join(trialRoot, "task.tar.gz");
        await writeFile(archive, bundle, { mode: 0o600 });
        const extracted = join(trialRoot, "task");
        await mkdir(extracted);
        await extractRegularArchive(
          archive,
          extracted,
          options.signal ? { signal: options.signal } : {},
        );
        const taskPath = await readFile(join(extracted, "harbor-task", "task.toml")).then(
          () => join(extracted, "harbor-task"),
          () => extracted,
        );
        const gateway = gatewayTrial(input, trial.harness, profile.model, child);
        const prepared = await prepareHarborRun(taskPath, trialRoot, gateway.child, options.signal);
        await runTrial({
          store,
          run,
          trial,
          index,
          taskPath,
          jobs: join(trialRoot, "jobs"),
          ...gateway,
          child: prepared.env,
          guard: prepared.guard,
          command,
          redact,
          options,
        });
      } catch (error) {
        trial.status = "failed";
        trial.error = redact(error instanceof Error ? error.message : "Solver failed");
      }
      trial.finishedAt = new Date().toISOString();
      await saveEvaluation(store, run);
    }
    run.status = run.trials.some((trial) => trial.status === "failed") ? "failed" : "completed";
  } catch (error) {
    run.status = "failed";
    run.error = redact(error instanceof Error ? error.message : "Evaluation failed");
  } finally {
    for (const trial of run.trials) {
      if (trial.status === "queued" || trial.status === "running") {
        trial.status = "failed";
        trial.error = "Not completed because the evaluation stopped";
      }
    }
    run.finishedAt = new Date().toISOString();
    try {
      await saveEvaluation(store, run);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
async function runTrial(context: {
  store: ArtifactStore;
  run: EvaluationRun;
  trial: EvaluationTrial;
  index: number;
  taskPath: string;
  jobs: string;
  guard: HarborOutputGuard;
  model: string;
  child: NodeJS.ProcessEnv;
  extraAllowedHosts?: readonly string[];
  command: typeof runCommand;
  redact: (text: string) => string;
  options: RunnerOptions;
}): Promise<void> {
  const { store, run, trial, index, taskPath, jobs, model, child, command, redact, options } =
    context;
  let stdout = "";
  let outputs = new Map<string, string>();
  let polling = Promise.resolve();
  let refreshing = false;
  let lastSnapshot = "";
  const refresh = async (archive: boolean) => {
    const files = await collectOutput(jobs);
    const clean = new Map(
      [...files].map(([name, text]) => [
        name,
        redact(!archive && !name.endsWith(".json") ? completeLines(text) : text),
      ]),
    );
    const trajectory = [...clean].find(([name]) => name.endsWith("/trajectory.json"));
    const pi = [...clean].find(([name]) => name.endsWith("/pi.txt"));
    if (trajectory) {
      try {
        trial.steps = trajectorySteps(JSON.parse(trajectory[1]));
      } catch {
        trial.steps = [];
      }
    } else if (pi) trial.steps = piSteps(pi[1]);
    trial.steps = boundedSteps(trial.steps);
    outputs = clean;
    trial.log = trialLog(redact(archive ? stdout : completeLines(stdout)), clean);
    if (archive) {
      for (const [name, text] of clean) {
        const artifactName = `${index}/${name}`;
        await store.put(
          `${evaluationPrefix(run.repoId, run.id)}artifacts/${artifactName}`,
          Buffer.from(text),
          "text/plain",
        );
        trial.artifacts.push(artifactName);
      }
      const result = [...files].find(([name]) => /^solver\/[^/]+\/result\.json$/.test(name));
      if (!result) throw new Error("Harbor did not produce a trial result");
      const parsed = record(JSON.parse(result[1]));
      Object.assign(trial, trialCost(run, trial.harness, files, parsed));
      const rewards = record(record(parsed.verifier_result).rewards);
      trial.rewards = Object.fromEntries(
        Object.entries(rewards).filter(
          (pair): pair is [string, number] =>
            typeof pair[1] === "number" && Number.isFinite(pair[1]),
        ),
      );
      if (parsed.exception_info)
        throw new Error(
          String(record(parsed.exception_info).exception_message ?? "Harbor trial failed"),
        );
      if (Object.keys(trial.rewards).length === 0)
        throw new Error("Harbor returned no verifier scores");
    }
    const snapshot = JSON.stringify(trial);
    if (snapshot !== lastSnapshot) {
      await saveEvaluation(store, run);
      lastSnapshot = snapshot;
    }
  };
  const timer = setInterval(() => {
    options.heartbeat?.();
    if (refreshing) return;
    refreshing = true;
    polling = polling
      .then(() => refresh(false))
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  }, options.pollMs ?? 3000);
  try {
    const result = await context.guard.watch(
      command(
        "harbor",
        solverArguments(
          taskPath,
          jobs,
          trial.harness,
          model,
          run.sandbox,
          run.thinking,
          context.extraAllowedHosts,
        ),
        {
          env: child,
          cwd: taskPath,
          timeoutMs: HARBOR_PROCESS_TIMEOUT_MS.solver,
          allowFailure: true,
          signal: context.guard.signal,
          onOutput: (_stream, chunk) => {
            stdout = `${stdout}${Buffer.from(chunk).toString("utf8")}`.slice(-200_000);
          },
        },
      ),
    );
    clearInterval(timer);
    await polling;
    await refresh(true);
    if (result.exitCode !== 0) throw new Error(`Harbor exited with status ${result.exitCode}`);
    trial.status = "completed";
  } catch (error) {
    clearInterval(timer);
    await polling;
    if (trial.artifacts.length === 0) await refresh(true).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(timer);
    await polling;
    trial.log = trialLog(redact(stdout), outputs);
  }
}
