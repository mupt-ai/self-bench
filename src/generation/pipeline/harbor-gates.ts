import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import { executionEnvironment } from "../../contracts/config/execution-environment.js";
import type { SelfBenchConfig } from "../../contracts/config/index.js";
import type { AuthoredTask, HarborRewards, VerifyReport } from "../../contracts/index.js";
import {
  assertHarborVersion,
  HARBOR_PROCESS_TIMEOUT_MS,
  harborProcessEnvironment,
  harborRunArguments,
} from "../../harnesses/harbor/command.js";
import {
  type HarborJobResult,
  harborInfrastructureError,
  readHarborJobResult,
} from "../../harnesses/harbor/results.js";
import { runCommand } from "../../lib/process.js";
import { isRecord, tail } from "../../lib/util.js";
import { providerEnvironment } from "../../sandbox/provider-environment.js";
import { type HarborLiveRun, harborLiveFeed, providerSecrets } from "./harbor-live.js";
import { activityAttempt } from "./helpers.js";
import { fetchSnapshotInBuild, type RemoteGate, unpackTask } from "./remote-gate.js";
import { nopGatePassed, oracleGatePassed } from "./verify-report.js";

export type HarborGates = Pick<VerifyReport, "build" | "smoke" | "nop" | "oracle">;

const NOP_REWARD_KEYS = [
  "structured_results",
  "patch_applied",
  "fail_to_pass",
  "pass_to_pass",
  "deterministic",
  "setup_completed",
  "fail_to_pass_exit_code",
  "fail_to_pass_repeat_exit_code",
  "pass_to_pass_exit_code",
] as const;
const SMOKE_MARKER = "--- selfbench smoke ---";
const NOP_MARKER = "--- selfbench nop ---";

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
 * Two Harbor runs over the compiled task. The first swaps the verifier script for one that runs
 * smoke and then the real nop split (building both images on the way); the second is the oracle.
 * Harbor or provider outages throw so Temporal retries them instead of charging the author.
 */
export async function runHarborGates(
  store: ArtifactStore,
  task: AuthoredTask,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  prefix: string,
  signal: AbortSignal,
  remote?: RemoteGate,
): Promise<HarborGates> {
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

    await writeFile(join(directory, "tests/test.sh"), smokeAndNopScript(), { mode: 0o755 });
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
    const buildError = trialError(first.trial);
    if (buildError) {
      gates.build = {
        ran: true,
        ok: false,
        infrastructure: false,
        ...(await log("build.log", failureText(buildError, first))),
      };
      return gates;
    }
    const firstRewards = rewards(first.trial);
    const output = verifierOutput(first);
    gates.build = { ran: true, ok: true, infrastructure: false, logTail: "" };
    const smokeOk = firstRewards.smoke_exit_code === 0;
    gates.smoke = {
      ran: true,
      ok: smokeOk,
      ...(await log("smoke.log", section(output, SMOKE_MARKER, NOP_MARKER))),
    };
    if (!smokeOk) return gates;
    const nopRewards: HarborRewards = {};
    for (const key of NOP_REWARD_KEYS) {
      const value = firstRewards[`nop_${key}`];
      if (typeof value === "number") nopRewards[key] = value;
    }
    gates.nop = {
      ran: true,
      ok: nopGatePassed(nopRewards),
      rewards: nopRewards,
      ...(await log("nop.log", section(output, NOP_MARKER))),
    };
    if (!gates.nop.ok) return gates;

    await copyFile(join(directory, "tests/task-test.sh"), join(directory, "tests/test.sh"));
    const oracle = await harborRun(
      directory,
      root,
      task.taskId,
      "oracle",
      harborEnvironment,
      signal,
      live("oracle"),
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
    return gates;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** One `harbor run` over a task directory; jobs land under `<root>/jobs`. */
export async function harborRun(
  taskDirectory: string,
  root: string,
  taskId: string,
  agent: "nop" | "oracle",
  environment: SelfBenchConfig["harborEnvironment"],
  signal: AbortSignal,
  /** Where to publish progress snapshots while the run is in flight. */
  live?: { store: ArtifactStore; prefix: string; run: HarborLiveRun },
): Promise<HarborJobResult> {
  const jobsDirectory = join(root, "jobs");
  const jobName = `${taskId}-${agent}-${crypto.randomUUID().slice(0, 8)}`;
  const env = harborProcessEnvironment(providerEnvironment(executionEnvironment(), environment));
  const version = await runCommand("harbor", ["--version"], { env, timeoutMs: 15_000, signal });
  assertHarborVersion(version.stdout);
  const feed =
    live &&
    harborLiveFeed(live.store, live.prefix, live.run, join(jobsDirectory, jobName), {
      attempt: activityAttempt(),
      secrets: providerSecrets(env),
    });
  const run = await runCommand(
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
      env,
      timeoutMs: HARBOR_PROCESS_TIMEOUT_MS.gate,
      signal,
      ...(feed ? { onOutput: feed.push } : {}),
    },
  ).finally(() => feed?.close());
  if (run.exitCode !== 0) {
    throw new Error(
      `Harbor ${agent} exited ${run.exitCode} for ${taskId}:\n${tail(`${run.stdout}\n${run.stderr}`.trim())}`,
    );
  }
  const result = await readHarborJobResult(jobsDirectory, jobName);
  const infrastructure = harborInfrastructureError(result.trial);
  if (infrastructure)
    throw new Error(`Harbor ${agent} infrastructure failure for ${taskId}: ${infrastructure}`);
  return result;
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

function section(output: string, start: string, end?: string): string {
  const from = output.indexOf(start);
  if (from < 0) return output;
  const body = output.slice(from + start.length);
  const to = end ? body.indexOf(end) : -1;
  return (to >= 0 ? body.slice(0, to) : body).trim();
}

/** Verifier script for the first run: smoke, then the nop split with rewards under `nop_*`. */
function smokeAndNopScript(): string {
  const fields = NOP_REWARD_KEYS.map(
    (key) => `printf ', "nop_${key}": %s' "$(field ${key} ${key.endsWith("_code") ? "-1" : "0"})"`,
  ).join("\n");
  return `#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier
# Image post-processing (Modal runs as root with HOME=/home/verifier) can leave root-owned files
# in the verifier's caches; the runtime user must own its home before it runs.
chown -R verifier:verifier /home/verifier 2>/dev/null || true
echo '${SMOKE_MARKER}'
smoke_status=0
runuser -u verifier --preserve-environment -- env -u XDG_CACHE_HOME HOME=/home/verifier /opt/selfbench-environment/smoke.sh 2>&1 || smoke_status=$?
echo "smoke exit code: $smoke_status"
nop_ran=0
nop_rewards='{}'
if [ "$smoke_status" -eq 0 ]; then
  echo '${NOP_MARKER}'
  nop_ran=1
  /tests/task-test.sh 2>&1 || true
  nop_rewards="$(cat /logs/verifier/reward.json 2>/dev/null || printf '{}')"
fi
field() { printf '%s' "$nop_rewards" | sed -n 's/.*"'"$1"'": *\\(-\\{0,1\\}[0-9]\\{1,\\}\\).*/\\1/p' | head -n 1 | grep . || printf '%s' "$2"; }
{
  printf '{"reward": 0, "smoke_exit_code": %s, "nop_ran": %s' "$smoke_status" "$nop_ran"
${fields}
  printf '}\\n'
} > /logs/verifier/reward.json
exit 0
`;
}
