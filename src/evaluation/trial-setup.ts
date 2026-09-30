import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/index.js";
import { trialTimeouts } from "../contracts/agent-limit.js";
import {
  assertHarborVersion,
  HARBOR_PROCESS_TIMEOUT_MS,
  harborProcessEnvironment,
} from "../harnesses/harbor/command.js";
import { prepareHarborRun, refuseWithoutRetry } from "../harnesses/harbor/task-safety.js";
import type { runCommand } from "../lib/process.js";
import { credentialExecution, gatewayTrial, refuseTrial } from "./execution.js";
import type { RunnerOptions } from "./runner.js";
import { unpackTrialTask } from "./task-bundle.js";
import type { EvaluationInput, EvaluationRun, EvaluationTrial } from "./types.js";

/**
 * Readies a claimed trial for its solver under `root`: its credentials, a supported Harbor, its
 * checked task, and the gateway its harness reaches the model through. Nothing here spends model
 * money. Secrets are added to `secrets` as they are resolved, so any later error can be redacted.
 * `setupSignal` stops the setup; the returned guard, which Harbor runs under, follows only `signal`.
 */
export async function setUpTrial(
  store: ArtifactStore,
  input: EvaluationInput,
  run: EvaluationRun,
  trial: EvaluationTrial,
  root: string,
  secrets: string[],
  options: RunnerOptions & {
    command: typeof runCommand;
    env: NodeJS.ProcessEnv;
    setupSignal?: AbortSignal;
  },
) {
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  if (!options.vault) throw refuseTrial("Credential storage unavailable on the worker");
  const execution = await credentialExecution(input, home, options.env, options.vault);
  secrets.push(...execution.secrets);
  const child = harborProcessEnvironment(execution.child);
  const version = await options.command("harbor", ["--version"], {
    env: child,
    timeoutMs: HARBOR_PROCESS_TIMEOUT_MS.version,
    ...(options.setupSignal ? { signal: options.setupSignal } : {}),
  });
  try {
    assertHarborVersion(version.stdout);
  } catch (error) {
    throw refuseTrial(error instanceof Error ? error.message : "Unsupported Harbor");
  }
  options.setupSignal?.throwIfAborted();
  const task = input.tasks.find(
    (candidate) => candidate.runId === trial.runId && candidate.taskId === trial.taskId,
  );
  if (!task) throw refuseTrial("Evaluation task snapshot is missing");
  const trialRoot = join(root, "trial");
  await mkdir(trialRoot);
  const taskPath = await unpackTrialTask(store, task, run.sandbox, trialRoot, {
    ...(options.snapshotLink ? { snapshotLink: options.snapshotLink } : {}),
    ...(options.setupSignal ? { signal: options.setupSignal } : {}),
  });
  const gateway = gatewayTrial(input, trial.harness, execution.profile.model, child);
  const prepared = await prepareHarborRun(
    taskPath,
    trialRoot,
    gateway.child,
    options.signal,
    trialTimeouts(input.agentMinutes).agentSeconds,
  ).catch(refuseWithoutRetry);
  return {
    taskPath,
    jobs: join(trialRoot, "jobs"),
    ...(task.images ? { images: task.images } : {}),
    ...gateway,
    modelAuth: execution.auth,
    child: prepared.env,
    guard: prepared.guard,
  };
}
