import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import type { ArtifactStore } from "../artifacts/index.js";
import type { HarborEnvironment } from "../contracts/config/providers.js";
import type { ThinkingLevel } from "../contracts/models.js";
import type { TaskImages } from "../contracts/task.js";
import type { Vault } from "../db/vault.js";
import type { SandboxCallback } from "../generation/pipeline/sandbox-job.js";
import { HARBOR_PROCESS_TIMEOUT_MS, harborRunArguments } from "../harnesses/harbor/command.js";
import type { HarborOutputGuard } from "../harnesses/harbor/output-guard.js";
import { pinnedImageKwargs } from "../harnesses/harbor/pinned-images.js";
import { runCommand } from "../lib/process.js";
import { claimTrial } from "./claim.js";
import { trialCost } from "./cost.js";
import { solverAgent } from "./execution.js";
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
import { evaluationPrefix, RepeatSpendError } from "./store.js";
import { setUpTrial } from "./trial-setup.js";
import type { EvaluationInput, EvaluationRun, EvaluationTrial, Harness } from "./types.js";

export function solverArguments(
  taskPath: string,
  jobs: string,
  harness: Harness,
  model: string,
  sandbox: HarborEnvironment,
  thinking?: ThinkingLevel,
  extraAllowedHosts: readonly string[] = [],
  images?: TaskImages,
): string[] {
  return harborRunArguments({
    taskPath,
    jobsPath: jobs,
    jobName: "solver",
    agent: solverAgent(harness, model),
    environment: sandbox,
    solver: { model, agentArguments: thinkingArguments(harness, thinking) },
    extraAllowedHosts,
    // Pinned images are Modal image IDs; every other backend builds the task's Dockerfiles.
    ...(sandbox === "modal" ? { environmentKwargs: pinnedImageKwargs(images) } : {}),
  });
}
export interface RunnerOptions {
  command?: typeof runCommand;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  heartbeat?: () => void;
  pollMs?: number;
  /** The least time between saves of a running trial's live output; scales with trial count. */
  progressMs?: number;
  vault?: Pick<Vault, "credentials" | "comparisons">;
  /** Signs the snapshot links Modal image builds fetch; see unpackTrialTask. */
  snapshotLink?: SandboxCallback;
  /**
   * Another attempt follows if this one throws: a trial whose setup fails before its solver
   * starts is then returned to the queue for it, unless the failure is final (refuseTrial).
   */
  retry?: boolean;
  /** Aborts when the worker is being stopped: a trial not yet solving then leaves for another. */
  stopping?: AbortSignal;
}

/**
 * Runs one trial of a started evaluation under this attempt's claim (claimTrial), so the solver
 * starts at most once however often the trial is delivered. A retryable failure before the solver
 * starts returns the claim for the next attempt. Every save replaces only this trial, so trials
 * running in parallel never overwrite each other.
 */
export async function executeTrial(
  store: ArtifactStore,
  input: EvaluationInput,
  index: number,
  options: RunnerOptions = {},
): Promise<void> {
  const claim = await claimTrial(store, input, index);
  const { run, trial } = claim;
  const save = () => claim.save(trial);
  const root = await mkdtemp(join(tmpdir(), "selfbench-evaluation-"));
  const command = options.command ?? runCommand;
  const environment = options.env ?? process.env;
  const secrets = Object.entries(environment)
    .filter(([name]) => /SECRET|TOKEN|PASSWORD|API_KEY/.test(name))
    .map(([, value]) => value ?? "")
    .filter(Boolean);
  const redact = (text: string) => redactOutput(text, secrets);
  // The solver may spend from the moment it starts, so only a failure before then is retried.
  let solving = false;
  let retrying = false;
  try {
    const ready = await setUpTrial(store, input, run, trial, root, secrets, {
      ...options,
      command,
      env: environment,
    });
    if (options.stopping?.aborted) throw new Error("Worker stopped before the solver started");
    trial.solverStartedAt = await claim.startSolver();
    solving = true;
    await runTrial({ store, run, trial, index, save, ...ready, command, redact, options });
  } catch (error) {
    // This attempt lost its claim; whoever holds the trial now records its outcome.
    if (error instanceof RepeatSpendError) throw error;
    const message = redact(error instanceof Error ? error.message : "Solver failed");
    // A retry needs the trial back in the queue; if that write fails, the failure is recorded here.
    retrying =
      !solving &&
      options.retry === true &&
      !options.signal?.aborted &&
      !(error instanceof ApplicationFailure && error.nonRetryable) &&
      (await claim.requeue().then(
        () => true,
        () => false,
      ));
    if (retrying) throw new Error(message);
    trial.status = "failed";
    trial.error = message;
  } finally {
    try {
      if (!retrying) {
        trial.finishedAt = new Date().toISOString();
        await save();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  options.signal?.throwIfAborted();
}

async function runTrial(context: {
  store: ArtifactStore;
  run: EvaluationRun;
  trial: EvaluationTrial;
  index: number;
  save: () => Promise<void>;
  taskPath: string;
  jobs: string;
  guard: HarborOutputGuard;
  model: string;
  modelAuth: "api-key" | "codex-login";
  child: NodeJS.ProcessEnv;
  extraAllowedHosts?: readonly string[];
  images?: TaskImages;
  command: typeof runCommand;
  redact: (text: string) => string;
  options: RunnerOptions;
}): Promise<void> {
  const { store, run, trial, index, save, taskPath, jobs, model, child, command, redact, options } =
    context;
  let stdout = "";
  let outputs = new Map<string, string>();
  let polling = Promise.resolve();
  let refreshing = false;
  let lastSnapshot = "";
  let lastSave = 0;
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
      Object.assign(trial, trialCost(run, trial.harness, files, parsed, context.modelAuth));
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
    // Trials share one record: live output waits ten seconds or a second per trial, if longer.
    const interval = options.progressMs ?? Math.max(10_000, run.trials.length * 1_000);
    if (!archive && Date.now() - lastSave < interval) return;
    const snapshot = JSON.stringify(trial);
    if (snapshot !== lastSnapshot) {
      await save();
      lastSnapshot = snapshot;
      lastSave = Date.now();
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
          context.images,
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
