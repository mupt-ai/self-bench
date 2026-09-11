import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRegularArchive } from "../archive.js";
import type { ArtifactStore } from "../artifacts.js";
import { runCommand } from "../process.js";
import { HARBOR_VERSION, solverEnvironment } from "./config.js";
import { trialCost } from "./cost.js";
import { credentialExecution } from "./credential-execution.js";
import type { EncryptedRecordStore } from "./encrypted-records.js";
import { gatewayTrial } from "./gateway-execution.js";
import { type ThinkingLevel, thinkingArguments } from "./model-options.js";
import {
  boundedSteps,
  collectOutput,
  completeLines,
  piSteps,
  record,
  redactOutput,
  trajectorySteps,
} from "./output.js";
import { profileEnvironment } from "./profiles.js";
import { evaluationPrefix, getEvaluation, saveEvaluation } from "./store.js";
import type { EvaluationInput, EvaluationRun, EvaluationTrial, Harness } from "./types.js";

export function solverArguments(
  taskPath: string,
  jobs: string,
  harness: Harness,
  model: string,
  sandbox: string,
  thinking?: ThinkingLevel,
): string[] {
  return [
    "run",
    "--path",
    taskPath,
    "--agent",
    harness === "codex" && model.startsWith("openai/") && model.slice(7).includes("/")
      ? "harbor_gateway:GatewayCodex"
      : harness,
    "--model",
    model,
    "--env",
    sandbox === "e2b" ? "harbor_e2b:SelfBenchE2BEnvironment" : sandbox,
    "--jobs-dir",
    jobs,
    "--job-name",
    "solver",
    "--n-attempts",
    "1",
    "--n-concurrent",
    "1",
    "--max-retries",
    "0",
    "--delete",
    "--yes",
    ...thinkingArguments(harness, thinking),
  ];
}
export interface RunnerOptions {
  command?: typeof runCommand;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  heartbeat?: () => void;
  pollMs?: number;
  records?: EncryptedRecordStore;
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
    const resolved = input.credentials
      ? environment
      : await profileEnvironment(store, input, environment);
    secrets.push(
      ...Object.entries(resolved)
        .filter(([name]) => name.startsWith("SELFBENCH_EVAL_SECRET_"))
        .map(([, value]) => value ?? "")
        .filter(Boolean),
    );
    if (input.credentials && !options.records)
      throw new Error("Credential storage unavailable on the worker");
    const execution =
      input.credentials && options.records
        ? await credentialExecution(input, home, environment, options.records)
        : { ...solverEnvironment(input, home, resolved), secrets: [] };
    secrets.push(...execution.secrets);
    const { profile, child } = execution;
    child.PYTHONPATH = dirname(fileURLToPath(import.meta.url));
    const version = await command("harbor", ["--version"], { env: child, timeoutMs: 15_000 });
    if (version.stdout.trim() !== HARBOR_VERSION)
      throw new Error("Worker Harbor version does not match the supported version");
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
        if (!bundle || bundle.byteLength > 100 * 1024 * 1024)
          throw new Error("Task bundle is missing or exceeds 100 MiB");
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
        await readFile(join(taskPath, "task.toml"));
        await runTrial({
          store,
          run,
          trial,
          index,
          taskPath,
          jobs: join(trialRoot, "jobs"),
          ...gatewayTrial(input, trial.harness, profile.model, child),
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
  model: string;
  child: NodeJS.ProcessEnv;
  command: typeof runCommand;
  redact: (text: string) => string;
  options: RunnerOptions;
}): Promise<void> {
  const { store, run, trial, index, taskPath, jobs, model, child, command, redact, options } =
    context;
  let stdout = "";
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
    trial.log = [
      redact(archive ? stdout : completeLines(stdout)),
      ...[...clean]
        .filter(([name]) => /\.(log|txt)$/.test(name))
        .map(([name, text]) => `\n--- ${name} ---\n${text}`),
    ]
      .join("\n")
      .slice(-100_000);
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
    const result = await command(
      "harbor",
      solverArguments(taskPath, jobs, trial.harness, model, run.sandbox, run.thinking),
      {
        env: child,
        cwd: taskPath,
        timeoutMs: 2 * 60 * 60 * 1000,
        allowFailure: true,
        ...(options.signal ? { signal: options.signal } : {}),
        onOutput: (_stream, chunk) => {
          stdout = `${stdout}${Buffer.from(chunk).toString("utf8")}`.slice(-200_000);
        },
      },
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
    trial.log = `${trial.log}\n${redact(stdout)}`.slice(-100_000);
  }
}
