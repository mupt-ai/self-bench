import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { startFromTaskImages } from "../../harnesses/harbor/registry-pull.js";
import {
  type HarborJobResult,
  harborInfrastructureError,
  readHarborJobResult,
} from "../../harnesses/harbor/results.js";
import { prepareHarborRun, refuseWithoutRetry } from "../../harnesses/harbor/task-safety.js";
import { runCommand } from "../../lib/process.js";
import { isRecord, tail } from "../../lib/util.js";
import { providerEnvironment } from "../../sandbox/provider-environment.js";
import type { ImageBuild, TaskImageBuilder } from "../images/builder.js";
import { type HarborLiveRun, harborLiveFeed, providerSecrets } from "./harbor-live.js";
import { activityAttempt } from "./helpers.js";
import { unpackTask } from "./remote-gate.js";
import { smokeLog, smokeResult } from "./smoke-result.js";
import { nopGatePassed, oracleGatePassed } from "./verify-report.js";

export type HarborGates = Pick<VerifyReport, "build" | "smoke" | "nop" | "oracle">;

/** Runs smoke.sh inside the agent phase; see runtime/harbor_smoke.py. */
const SMOKE_AGENT = "harbor_smoke:SmokeAgent";

export function notRunGates(): HarborGates {
  const gate = { ran: false, ok: false, logTail: "" };
  return {
    build: { ...gate, infrastructure: false },
    smoke: gate,
    nop: { ...gate, rewards: {} },
    oracle: { ...gate, rewards: {} },
  };
}

/** Where a check's images come from, when the deployment builds them before its gates. */
export interface GateImages {
  readonly builder: TaskImageBuilder;
  readonly build: ImageBuild;
  /** What a provider needs to pull them: the worker's environment and the callback origin. */
  readonly serving: Parameters<typeof startFromTaskImages>[3];
}

/**
 * The build gate and two Harbor runs over the compiled task. With a builder, the build gate builds
 * both images into the task image repository (a failing Dockerfile step is the author's) and both
 * runs start from those digests on the run's provider; without one, the first run builds the full
 * bundle's Dockerfiles. The first run then runs smoke as the agent (agent image, [agent] user,
 * agent network allowlist) and the real nop split; the second is the oracle. Harbor or provider
 * outages throw so Temporal retries them instead of charging the author.
 */
export async function runHarborGates(
  store: ArtifactStore,
  task: Pick<AuthoredTask, "taskId" | "bundle">,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  prefix: string,
  signal: AbortSignal,
  images?: GateImages,
): Promise<HarborGates & { images?: TaskImages }> {
  const root = await mkdtemp(join(tmpdir(), `selfbench-${task.taskId}-`));
  try {
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
    let built: TaskImages | undefined;
    if (images) {
      const result = await images.builder.build(store, images.build, signal);
      if ("failure" in result) {
        gates.build = {
          ran: true,
          ok: false,
          infrastructure: false,
          ...(await log("build.log", result.failure)),
        };
        return gates;
      }
      built = result.images;
    }
    const pulling = built && images ? { images: built, serving: images.serving } : undefined;
    // Starting from images rewrites task.toml, which each run's safety check reads afresh, so each
    // run gets its own copy of the small gate task; a full bundle is unpacked once.
    const bundle = images ? undefined : await unpackTask(store, task.bundle, root, signal);
    const directory = async (run: HarborLiveRun) => {
      if (bundle || !images) return bundle ?? "";
      const folder = join(root, run);
      await mkdir(folder);
      return await unpackTask(store, images.build.gate, folder, signal);
    };
    const live = (run: HarborLiveRun) => ({ store, prefix, run });
    const first = await harborRun(
      await directory("nop"),
      root,
      task.taskId,
      "nop",
      harborEnvironment,
      signal,
      live("nop"),
      pulling,
    );
    await storeResult(store, `${gateOutputs}/smoke-nop`, first);
    const smoke = smokeResult(first.trial);
    const buildError = trialError(first.trial);
    // The images built already, so a trial that failed before smoke could not start from them:
    // Harbor's or the provider's trouble, which Temporal retries, never the author's.
    if (buildError && !smoke.failed && built)
      throw new Error(`Harbor nop could not start ${task.taskId} from its images: ${buildError}`);
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

    const oracle = await harborRun(
      await directory("oracle"),
      root,
      task.taskId,
      "oracle",
      harborEnvironment,
      signal,
      live("oracle"),
      pulling,
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
    return gates.oracle.ok && built ? { ...gates, images: built } : gates;
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
  /** The task's images, which the run starts from instead of building its Dockerfiles. */
  pulling?: { readonly images: TaskImages; readonly serving: GateImages["serving"] },
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
  const pull = pulling
    ? await startFromTaskImages(taskDirectory, pulling.images, environment, pulling.serving)
    : {};
  const runEnv = { ...harbor.env, ...pull };
  const feed =
    live &&
    harborLiveFeed(live.store, live.prefix, live.run, join(jobsDirectory, jobName), {
      attempt: activityAttempt(),
      secrets: providerSecrets(runEnv),
    });
  const trial = runCommand(
    "harbor",
    harborRunArguments({
      taskPath: taskDirectory,
      jobsPath: jobsDirectory,
      jobName,
      agent,
      environment,
      quiet: false,
    }),
    {
      allowFailure: true,
      env: runEnv,
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
