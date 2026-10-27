import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/index.js";
import { trialTimeouts } from "../contracts/agent-limit.js";
import { type GatewayConnection, gatewayConnection } from "../gateway/connection.js";
import {
  assertHarborVersion,
  HARBOR_PROCESS_TIMEOUT_MS,
  harborProcessEnvironment,
} from "../harnesses/harbor/command.js";
import { hostVariables } from "../harnesses/harbor/host-variables.js";
import { startFromTaskImages } from "../harnesses/harbor/registry-pull.js";
import {
  prepareHarborRun,
  readTaskConfig,
  refuseWithoutRetry,
} from "../harnesses/harbor/task-safety.js";
import type { runCommand } from "../lib/process.js";
import { credentialExecution } from "./execution.js";
import {
  allowedHosts,
  gatewayModelId,
  gatewayTrial,
  gatewayTrialTag,
  pinnedThinking,
} from "./gateway-trial.js";
import { judgeEnvironment, judgeTrial } from "./judge.js";
import { refuseTrial } from "./refusal.js";
import type { RunnerOptions } from "./runner.js";
import { unpackTrialTask } from "./task-bundle.js";
import type { EvaluationInput, EvaluationRun, EvaluationTrial } from "./types.js";

/**
 * Readies a claimed trial for its solver under `root`: its credentials, a supported Harbor, its
 * checked task, and the connection its harness reaches the model through (the gateway, for an API
 * key). Nothing here spends model money. Secrets are added to `secrets` as they are resolved, so
 * any later error can be redacted. `setupSignal` stops the setup; the returned guard, which Harbor
 * runs under, follows only `signal`.
 */
export async function setUpTrial(
  store: ArtifactStore,
  input: EvaluationInput,
  run: EvaluationRun,
  trial: EvaluationTrial,
  index: number,
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
  const execution = await credentialExecution(
    input,
    home,
    options.env,
    options.vault,
    trial.harness,
  );
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
  // The trial reaches its model through the gateway, under a key that pins the model, unless its
  // route is direct. A judge calls the gateway under its own key, which names only its credential:
  // a key never serves both the model under test and the judge, so the two are never confused.
  const gatewayed = execution.route === "gateway";
  const gatewayAt = () => {
    if (!options.gateway) throw refuseTrial("The model gateway is not configured on this worker");
    return options.gateway;
  };
  const tags = { run: run.id, trial: gatewayTrialTag(run, index), harness: trial.harness };
  let connection: GatewayConnection | undefined;
  if (gatewayed) {
    const at = gatewayAt();
    const thinking = pinnedThinking(trial.harness, input.thinking);
    connection = gatewayConnection(at.api.url, at.api.secret, {
      orgId: execution.credential.orgId,
      credentialId: execution.credential.id,
      model: gatewayModelId(input),
      ...(thinking ? { thinking } : {}),
      // Codex speaks Responses; a custom endpoint must serve it that way, as its direct route did.
      ...(trial.harness === "codex" ? { api: "openai-responses" as const } : {}),
      tags,
    });
    secrets.push(connection.key);
  }
  const judgeConnection = execution.judge
    ? gatewayConnection(gatewayAt().api.url, gatewayAt().api.secret, {
        orgId: execution.credential.orgId,
        judge: execution.judge,
        tags,
      })
    : undefined;
  if (judgeConnection) secrets.push(judgeConnection.key);
  const gateway = gatewayTrial(input, trial.harness, execution.profile.model, child, connection);
  const extraAllowedHosts = allowedHosts(gateway, judgeConnection);
  const prepared = await prepareHarborRun(
    taskPath,
    trialRoot,
    gateway.child,
    options.signal,
    trialTimeouts(run.agentMinutes).agentSeconds,
    // A registry task runs exactly as published, with its own limits.
    { published: !!task.registry },
  ).catch(refuseWithoutRetry);
  // A registry task's env tables read their host variables from the judge credential alone.
  const judged = task.registry
    ? judgeTrial(
        hostVariables(await readTaskConfig(taskPath)),
        prepared.env,
        judgeConnection ? judgeEnvironment(judgeConnection) : {},
      )
    : { child: prepared.env, verifierEnv: [] };
  if ("refusal" in judged) throw refuseTrial(judged.refusal);
  // Every provider starts from the images the task's checks ran on, when it has them.
  const pull = await startFromTaskImages(taskPath, task.images, run.sandbox, {
    env: options.env,
    ...(options.snapshotLink ? { callback: options.snapshotLink } : {}),
  });
  if (pull.SELFBENCH_REGISTRY_PASSWORD) secrets.push(pull.SELFBENCH_REGISTRY_PASSWORD);
  return {
    taskPath,
    jobs: join(trialRoot, "jobs"),
    ...gateway,
    extraAllowedHosts,
    modelAuth: execution.auth,
    // A gateway trial's cost is what the gateway recorded for its calls (runner.ts).
    ...(gatewayed ? { gatewayOrgId: execution.credential.orgId } : {}),
    child: { ...judged.child, ...pull },
    verifierEnv: judged.verifierEnv,
    guard: prepared.guard,
  };
}
