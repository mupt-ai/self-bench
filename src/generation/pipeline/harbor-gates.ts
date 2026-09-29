import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import { executionEnvironment } from "../../contracts/config/execution-environment.js";
import type { SelfBenchConfig } from "../../contracts/config/index.js";
import type {
  AuthoredTask,
  HarborRewards,
  TaskImages,
  VerifyReport,
} from "../../contracts/index.js";
import {
  assertHarborVersion,
  HARBOR_PROCESS_TIMEOUT_MS,
  harborProcessEnvironment,
  harborRunArguments,
} from "../../harnesses/harbor/command.js";
import { authoredImageBuildFailure } from "../../harnesses/harbor/image-build.js";
import { recordedImages } from "../../harnesses/harbor/pinned-images.js";
import {
  type HarborJobResult,
  harborInfrastructureError,
  readHarborJobResult,
} from "../../harnesses/harbor/results.js";
import { prepareHarborRun, refuseWithoutRetry } from "../../harnesses/harbor/task-safety.js";
import { runCommand } from "../../lib/process.js";
import { isRecord, tail } from "../../lib/util.js";
import { providerEnvironment } from "../../sandbox/provider-environment.js";
import { type HarborLiveRun, harborLiveFeed, providerSecrets } from "./harbor-live.js";
import { activityAttempt } from "./helpers.js";
import { fetchSnapshotInBuild, type RemoteGate, unpackTask } from "./remote-gate.js";
import { nopGatePassed, oracleGatePassed } from "./verify-report.js";

export type HarborGates = Pick<VerifyReport, "build" | "smoke" | "nop" | "oracle">;

/** Runs smoke.sh inside the agent phase; see runtime/harbor_smoke.py. */
const SMOKE_AGENT = "harbor_smoke:SmokeAgent";
/** Exceptions that mean smoke itself failed or hung, not the image build. */
const SMOKE_FAILURES = new Set(["SmokeCheckFailed", "AgentTimeoutError"]);

export function notRunGates(): HarborGates {
  const gate = { ran: false, ok: false, logTail: "" };
  return {
    build: { ...gate, infrastructure: false },
    smoke: gate,
    nop: { ...gate, rewards: {} },
    oracle: { ...gate, rewards: {} },
  };
}

/**
 * Two Harbor runs over the compiled task. The first builds both images, runs smoke as the agent
 * (agent image, [agent] user, agent network allowlist), and then the real nop split; the second is
 * the oracle. Harbor or provider outages throw so Temporal retries them instead of charging the
 * author.
 */
export async function runHarborGates(
  store: ArtifactStore,
  task: AuthoredTask,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  prefix: string,
  signal: AbortSignal,
  remote?: RemoteGate,
): Promise<HarborGates & { images?: TaskImages }> {
  const root = await mkdtemp(join(tmpdir(), `selfbench-${task.taskId}-`));
  try {
    const directory = await unpackTask(store, remote?.bundle ?? task.bundle, root, signal);
    if (remote) await fetchSnapshotInBuild(directory, remote);
    // Artifacts are write-once: a retried verification keeps its gate outputs in its own folder.
    const attempt = activityAttempt();
    const gateOutputs = attempt > 1 ? `${prefix}/attempt-${attempt}` : prefix;
    const log = async (name: string, raw: string) => ({
      logTail: tail(raw.trim(), 4_000),
      log: await store.put(
        `${gateOutputs}/${name}`,
        Buffer.from(raw || "(empty log)\n"),
        "text/plain",
      ),
    });
    const gates = notRunGates();

    const live = (run: HarborLiveRun) => ({ store, prefix, run });
    const first = await harborRun(
      directory,
      root,
      task.taskId,
      "nop",
      harborEnvironment,
      signal,
      live("nop"),
    );
    await storeResult(store, `${gateOutputs}/smoke-nop`, first);
    const smoke = smokeResult(first.trial);
    const buildError = trialError(first.trial);
    if (buildError && !smoke.failed) {
      gates.build = {
        ran: true,
        ok: false,
        infrastructure: false,
        ...(await log("build.log", failureText(buildError, first))),
      };
      return gates;
    }
    gates.build = { ran: true, ok: true, infrastructure: false, logTail: "" };
    gates.smoke = {
      ran: true,
      ok: !smoke.failed,
      ...(await log("smoke.log", smokeLog(smoke, buildError))),
    };
    if (smoke.failed) return gates;
    const nopRewards = numericRewards(rewards(first.trial));
    gates.nop = {
      ran: true,
      ok: nopGatePassed(nopRewards),
      rewards: nopRewards,
      ...(await log("nop.log", verifierOutput(first))),
    };
    if (!gates.nop.ok) return gates;

    // The oracle's sandboxes start from exactly the images a trial would build.
    const imageRecord = join(root, "images");
    const oracle = await harborRun(
      directory,
      root,
      task.taskId,
      "oracle",
      harborEnvironment,
      signal,
      live("oracle"),
      harborEnvironment === "modal" ? { image_record_dir: imageRecord } : {},
    );
    await storeResult(store, `${gateOutputs}/oracle`, oracle);
    const oracleError = trialError(oracle.trial);
    const oracleRewards = oracleError ? {} : numericRewards(rewards(oracle.trial));
    gates.oracle = {
      ran: true,
      ok: !oracleError && oracleGatePassed(oracleRewards),
      rewards: oracleRewards,
      ...(await log(
        "oracle.log",
        oracleError ? failureText(oracleError, oracle) : verifierOutput(oracle),
      )),
    };
    if (!gates.oracle.ok || harborEnvironment !== "modal") return gates;
    const images = await recordedImages(imageRecord);
    return images ? { ...gates, images } : gates;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** One `harbor run` over a task directory; jobs land under `<root>/jobs`. */
export async function harborRun(
  taskDirectory: string,
  root: string,
  taskId: string,
  run: HarborLiveRun,
  environment: SelfBenchConfig["harborEnvironment"],
  signal: AbortSignal,
  /** Where to publish progress snapshots while the run is in flight. */
  live?: { store: ArtifactStore; prefix: string; run: HarborLiveRun },
  environmentKwargs: Readonly<Record<string, string>> = {},
): Promise<HarborJobResult> {
  const jobsDirectory = join(root, "jobs");
  const agent = run === "nop" ? SMOKE_AGENT : "oracle";
  const jobName = `${taskId}-${run}-${crypto.randomUUID().slice(0, 8)}`;
  const env = harborProcessEnvironment(providerEnvironment(executionEnvironment(), environment));
  const version = await runCommand("harbor", ["--version"], {
    env,
    timeoutMs: HARBOR_PROCESS_TIMEOUT_MS.version,
    signal,
  });
  assertHarborVersion(version.stdout);
  const harbor = await prepareHarborRun(taskDirectory, root, env, signal).catch(refuseWithoutRetry);
  const feed =
    live &&
    harborLiveFeed(live.store, live.prefix, live.run, join(jobsDirectory, jobName), {
      attempt: activityAttempt(),
      secrets: providerSecrets(env),
    });
  const trial = runCommand(
    "harbor",
    harborRunArguments({
      taskPath: taskDirectory,
      jobsPath: jobsDirectory,
      jobName,
      agent,
      environment,
      environmentKwargs,
      quiet: false,
    }),
    {
      allowFailure: true,
      env: harbor.env,
      timeoutMs: HARBOR_PROCESS_TIMEOUT_MS.gate,
      signal: harbor.guard.signal,
      ...(feed ? { onOutput: feed.push } : {}),
    },
  );
  const exited = await harbor.guard
    .watch(trial)
    .catch(refuseWithoutRetry)
    .finally(() => feed?.close());
  if (exited.exitCode !== 0) {
    throw new Error(
      `Harbor ${run} exited ${exited.exitCode} for ${taskId}:\n${tail(`${exited.stdout}\n${exited.stderr}`.trim())}`,
    );
  }
  const result = await readHarborJobResult(jobsDirectory, jobName).catch(refuseWithoutRetry);
  const infrastructure = harborInfrastructureError(result.trial);
  if (!infrastructure) return result;
  // A build that failed in the task's own Dockerfile steps is the author's to fix, not a retry.
  const buildLog = await authoredImageBuildFailure(infrastructure, env, signal);
  if (buildLog)
    return { ...result, trialLog: [result.trialLog, buildLog].filter(Boolean).join("\n\n") };
  throw new Error(`Harbor ${run} infrastructure failure for ${taskId}: ${infrastructure}`);
}

async function storeResult(
  store: ArtifactStore,
  prefix: string,
  result: HarborJobResult,
): Promise<void> {
  const body = JSON.stringify({ job: result.job, trial: result.trial }, null, 2);
  await store.put(`${prefix}.json`, Buffer.from(`${body}\n`), "application/json");
  const output = verifierOutput(result);
  if (output) await store.put(`${prefix}-verifier.log`, Buffer.from(output), "text/plain");
}

function verifierOutput(result: HarborJobResult): string {
  const { combined, stderr } = result.verifier ?? {};
  if (combined && stderr) return `${combined.trimEnd()}\n\n--- verifier stderr ---\n${stderr}`;
  return stderr ?? combined ?? "";
}

function failureText(error: string, result: HarborJobResult): string {
  return [error, result.trialLog ?? "", verifierOutput(result)]
    .filter((part) => part.trim())
    .join("\n\n");
}

function trialError(trial: unknown): string | undefined {
  const info = isRecord(trial) ? trial.exception_info : undefined;
  if (info === undefined || info === null) return undefined;
  if (!isRecord(info)) return JSON.stringify(info);
  const type = typeof info.exception_type === "string" ? `${info.exception_type}: ` : "";
  return `${type}${String(info.exception_message ?? "")}`;
}

function rewards(trial: unknown): Record<string, unknown> {
  const result = isRecord(trial) ? trial.verifier_result : undefined;
  return isRecord(result) && isRecord(result.rewards) ? result.rewards : {};
}

function numericRewards(raw: Record<string, unknown>): HarborRewards {
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

interface SmokeResult {
  readonly failed: boolean;
  readonly exitCode?: number;
  readonly output: string;
}

function smokeResult(trial: unknown): SmokeResult {
  const agent = isRecord(trial) ? trial.agent_result : undefined;
  const metadata = isRecord(agent) && isRecord(agent.metadata) ? agent.metadata : {};
  const output = typeof metadata.smoke_output === "string" ? metadata.smoke_output : "";
  const exitCode =
    typeof metadata.smoke_exit_code === "number" ? metadata.smoke_exit_code : undefined;
  const info = isRecord(trial) ? trial.exception_info : undefined;
  const raised = isRecord(info) && SMOKE_FAILURES.has(String(info.exception_type));
  // SmokeAgent raises on a non-zero exit, so a trial without one got past smoke (or never built).
  return {
    failed: raised || (exitCode ?? 0) !== 0,
    output,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function smokeLog(smoke: SmokeResult, error: string | undefined): string {
  if (!smoke.failed) return smoke.output;
  const status =
    smoke.exitCode === undefined
      ? `The smoke command did not finish in the agent environment${error ? ` (${error})` : ""}.`
      : `The smoke command exited ${smoke.exitCode} in the agent environment.`;
  return [
    status,
    "It ran exactly as the solver agent will: in the agent image, as root, with network limited to the model provider. Anything the agent needs (package managers, toolchains, Corepack shims, browsers) must be installed and cached by setupCommand, not downloaded on first use.",
    smoke.output,
  ]
    .filter((part) => part.trim())
    .join("\n\n");
}
