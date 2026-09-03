import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CancelledFailure } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import type { AuthoredTask, HarborRewards, VerifyReport } from "../../contracts.js";
import type { HarborJobResult } from "../../harbor-results.js";
import { nopGatePassed, oracleGatePassed } from "../../verify-report.js";
import { composeDiagnostics, isUnhealthyServiceFailure, storeGateLog } from "./gate-logs.js";
import {
  boundedTail,
  exception,
  isHarborInfrastructureApplicationFailure,
  rewards,
  runHarborGate,
  verifierOutput,
} from "./harbor.js";
import { modalBuildLogTail } from "./modal-build-log.js";
import { withActivityHeartbeats, withTaskBundle } from "./runtime.js";

export type HarborGates = Pick<VerifyReport, "build" | "smoke" | "nop" | "oracle">;

const NOP_REWARD_KEYS = [
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
 * Builds the task images and measures smoke, nop, and oracle on Harbor. The first run replaces the
 * verifier script with one that runs the smoke command and then the real nop split, preserving the
 * nop rewards under `nop_*` keys; the second run is the unchanged oracle. Harbor infrastructure
 * failures are reported as a red build flagged `infrastructure` instead of failing the activity.
 */
export async function runHarborGates(
  store: ArtifactStore,
  task: AuthoredTask,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  prefix: string,
): Promise<HarborGates> {
  return await withTaskBundle(store, task, async (taskDirectory, root) => {
    const gates = notRunGates();
    await writeFile(join(taskDirectory, "tests/test.sh"), smokeAndNopScript(), { mode: 0o755 });
    const first = await harborRun(taskDirectory, root, task.taskId, "nop", harborEnvironment);
    if ("infrastructure" in first) {
      const log = await storeGateLog(store, `${prefix}/build.log`, first.infrastructure);
      return { ...gates, build: { ran: true, ok: false, infrastructure: true, ...log } };
    }
    await storeHarborResult(store, `${prefix}/smoke-nop`, first);
    const trialError = exceptionMessage(first.trial);
    if (trialError !== undefined) {
      const log = await storeGateLog(
        store,
        `${prefix}/build.log`,
        await failureLog(trialError, first, harborEnvironment),
      );
      return { ...gates, build: { ran: true, ok: false, infrastructure: false, ...log } };
    }
    const firstRewards = rewards(first.trial);
    const output = verifierOutput(first) ?? "";
    const smokeOk = numberOf(firstRewards.smoke_exit_code) === 0;
    gates.build = { ran: true, ok: true, infrastructure: false, logTail: "" };
    gates.smoke = {
      ran: true,
      ok: smokeOk,
      ...(await storeGateLog(
        store,
        `${prefix}/smoke.log`,
        section(output, SMOKE_MARKER, NOP_MARKER),
      )),
    };
    if (!smokeOk) {
      return gates;
    }
    const nopRewards = nopRewardsFrom(firstRewards);
    gates.nop = {
      ran: true,
      ok: nopGatePassed(nopRewards),
      rewards: nopRewards,
      ...(await storeGateLog(store, `${prefix}/nop.log`, section(output, NOP_MARKER))),
    };
    if (!gates.nop.ok) {
      return gates;
    }
    await copyFile(join(taskDirectory, "tests/task-test.sh"), join(taskDirectory, "tests/test.sh"));
    const oracle = await harborRun(taskDirectory, root, task.taskId, "oracle", harborEnvironment);
    if ("infrastructure" in oracle) {
      const log = await storeGateLog(
        store,
        `${prefix}/oracle-build.log`,
        `during oracle run: ${oracle.infrastructure}`,
      );
      return { ...gates, build: { ran: true, ok: false, infrastructure: true, ...log } };
    }
    await storeHarborResult(store, `${prefix}/oracle`, oracle);
    const oracleError = exceptionMessage(oracle.trial);
    if (oracleError !== undefined) {
      const log = await storeGateLog(
        store,
        `${prefix}/oracle.log`,
        await failureLog(oracleError, oracle, harborEnvironment),
      );
      gates.oracle = { ran: true, ok: false, rewards: {}, ...log };
      return gates;
    }
    const oracleRewards = numericRewards(rewards(oracle.trial));
    gates.oracle = {
      ran: true,
      ok: oracleGatePassed(oracleRewards),
      rewards: oracleRewards,
      ...(await storeGateLog(store, `${prefix}/oracle.log`, verifierOutput(oracle) ?? "")),
    };
    return gates;
  });
}

/** Raw failure log: the trial exception, Harbor's trial.log, and compose diagnostics when relevant. */
async function failureLog(
  message: string,
  result: HarborJobResult,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
): Promise<string> {
  const parts = [message, result.trialLog ?? "", verifierOutput(result) ?? ""];
  if (isUnhealthyServiceFailure(`${message}\n${result.trialLog ?? ""}`)) {
    parts.push(await composeDiagnostics(result.trial, harborEnvironment));
  }
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

async function harborRun(
  taskDirectory: string,
  root: string,
  taskId: string,
  agent: "nop" | "oracle",
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
): Promise<HarborJobResult | { readonly infrastructure: string }> {
  try {
    return await withActivityHeartbeats(`running Harbor ${agent} for ${taskId}`, (options) =>
      runHarborGate(
        taskDirectory,
        join(root, "jobs"),
        agent,
        taskId,
        harborEnvironment,
        options.signal,
        false,
      ),
    );
  } catch (error) {
    if (error instanceof CancelledFailure || !isHarborInfrastructureApplicationFailure(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const buildLog = await modalBuildLogTail(message);
    return {
      infrastructure: buildLog ? `${boundedTail(message)}\n\n${buildLog}` : boundedTail(message),
    };
  }
}

async function storeHarborResult(
  store: ArtifactStore,
  prefix: string,
  result: HarborJobResult,
): Promise<void> {
  const output = verifierOutput(result);
  await Promise.all([
    store.put(
      `${prefix}.json`,
      Buffer.from(`${JSON.stringify({ job: result.job, trial: result.trial }, null, 2)}\n`),
      "application/json",
    ),
    output ? store.put(`${prefix}-verifier.log`, Buffer.from(output), "text/plain") : undefined,
  ]);
}

function exceptionMessage(trial: unknown): string | undefined {
  const info = exception(trial);
  if (info === undefined || info === null) {
    return undefined;
  }
  if (typeof info === "object" && "exception_message" in info) {
    const record = info as { exception_type?: unknown; exception_message?: unknown };
    return `${typeof record.exception_type === "string" ? `${record.exception_type}: ` : ""}${String(record.exception_message ?? "")}`;
  }
  return JSON.stringify(info);
}

function nopRewardsFrom(raw: Record<string, unknown>): HarborRewards {
  const mapped: Record<string, number> = {};
  for (const key of NOP_REWARD_KEYS) {
    const value = raw[`nop_${key}`];
    if (typeof value === "number") {
      mapped[key] = value;
    }
  }
  return mapped;
}

function numericRewards(raw: Record<string, unknown>): HarborRewards {
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function section(output: string, start: string, end?: string): string {
  const from = output.indexOf(start);
  if (from < 0) {
    return output;
  }
  const body = output.slice(from + start.length);
  const to = end ? body.indexOf(end) : -1;
  return (to >= 0 ? body.slice(0, to) : body).trim();
}

/** Verifier script for the smoke+nop run; nop rewards are re-emitted under `nop_*` keys. */
export function smokeAndNopScript(): string {
  const fields = NOP_REWARD_KEYS.map(
    (key) => `printf ', "nop_${key}": %s' "$(field ${key} ${key.endsWith("_code") ? "-1" : "0"})"`,
  ).join("\n");
  return `#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier
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
