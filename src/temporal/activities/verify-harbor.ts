import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CancelledFailure } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import type { AuthoredTask, HarborRewards, VerifyReport } from "../../contracts.js";
import { executionEnvironment } from "../../execution-environment.js";
import { harborChildEnvironment } from "../../harbor/environment.js";
import type { HarborJobResult } from "../../harbor/results.js";
import { runCommand } from "../../process.js";
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
import { activityLifetimeSignal, withActivityHeartbeats, withTaskBundle } from "./runtime.js";
import {
  NOP_MARKER,
  NOP_REWARD_KEYS,
  SMOKE_MARKER,
  smokeAndNopScript,
} from "./verify-harbor-script.js";

export type HarborGates = Pick<VerifyReport, "build" | "smoke" | "nop" | "oracle">;

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
  lifetime?: AbortSignal,
): Promise<HarborGates> {
  const signal = activityLifetimeSignal(lifetime);
  signal.throwIfAborted();
  const storeLog = async (key: string, raw: string) => {
    signal.throwIfAborted();
    const log = await storeGateLog(store, key, raw);
    signal.throwIfAborted();
    return log;
  };
  return await withTaskBundle(
    store,
    task,
    async (taskDirectory, root) => {
      signal.throwIfAborted();
      const gates = notRunGates();
      await writeFile(join(taskDirectory, "tests/test.sh"), smokeAndNopScript(), { mode: 0o755 });
      const first = await harborRun(
        taskDirectory,
        root,
        task.taskId,
        "nop",
        harborEnvironment,
        signal,
      );
      signal.throwIfAborted();
      if ("infrastructure" in first) {
        const log = await storeLog(`${prefix}/build.log`, first.infrastructure);
        return { ...gates, build: { ran: true, ok: false, infrastructure: true, ...log } };
      }
      await storeHarborResult(store, `${prefix}/smoke-nop`, first, signal);
      const trialError = exceptionMessage(first.trial);
      if (trialError !== undefined) {
        const log = await storeLog(
          `${prefix}/build.log`,
          await failureLog(trialError, first, harborEnvironment, signal),
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
        ...(await storeLog(`${prefix}/smoke.log`, section(output, SMOKE_MARKER, NOP_MARKER))),
      };
      if (!smokeOk) {
        return gates;
      }
      const nopRewards = nopRewardsFrom(firstRewards);
      gates.nop = {
        ran: true,
        ok: nopGatePassed(nopRewards),
        rewards: nopRewards,
        ...(await storeLog(`${prefix}/nop.log`, section(output, NOP_MARKER))),
      };
      if (!gates.nop.ok) {
        return gates;
      }
      signal.throwIfAborted();
      await copyFile(
        join(taskDirectory, "tests/task-test.sh"),
        join(taskDirectory, "tests/test.sh"),
      );
      const oracle = await harborRun(
        taskDirectory,
        root,
        task.taskId,
        "oracle",
        harborEnvironment,
        signal,
      );
      signal.throwIfAborted();
      if ("infrastructure" in oracle) {
        const log = await storeLog(
          `${prefix}/oracle-build.log`,
          `during oracle run: ${oracle.infrastructure}`,
        );
        return { ...gates, build: { ran: true, ok: false, infrastructure: true, ...log } };
      }
      await storeHarborResult(store, `${prefix}/oracle`, oracle, signal);
      const oracleError = exceptionMessage(oracle.trial);
      if (oracleError !== undefined) {
        const log = await storeLog(
          `${prefix}/oracle.log`,
          await failureLog(oracleError, oracle, harborEnvironment, signal),
        );
        gates.oracle = { ran: true, ok: false, rewards: {}, ...log };
        return gates;
      }
      const oracleRewards = numericRewards(rewards(oracle.trial));
      gates.oracle = {
        ran: true,
        ok: oracleGatePassed(oracleRewards),
        rewards: oracleRewards,
        ...(await storeLog(`${prefix}/oracle.log`, verifierOutput(oracle) ?? "")),
      };
      return gates;
    },
    signal,
  );
}

/** Raw failure log: the trial exception, Harbor's trial.log, and compose diagnostics when relevant. */
async function failureLog(
  message: string,
  result: HarborJobResult,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const parts = [message, result.trialLog ?? "", verifierOutput(result) ?? ""];
  if (isUnhealthyServiceFailure(`${message}\n${result.trialLog ?? ""}`)) {
    parts.push(
      await composeDiagnostics(result.trial, harborEnvironment, (command, args, options) => {
        signal.throwIfAborted();
        return runCommand(command, args, { ...options, signal });
      }),
    );
  }
  signal.throwIfAborted();
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

async function harborRun(
  taskDirectory: string,
  root: string,
  taskId: string,
  agent: "nop" | "oracle",
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  signal: AbortSignal,
): Promise<HarborJobResult | { readonly infrastructure: string }> {
  try {
    return await withActivityHeartbeats(
      `running Harbor ${agent} for ${taskId}`,
      (options) =>
        runHarborGate(
          taskDirectory,
          join(root, "jobs"),
          agent,
          taskId,
          harborEnvironment,
          options.signal,
          false,
        ),
      signal,
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CancelledFailure || !isHarborInfrastructureApplicationFailure(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const buildLog = await modalBuildLogTail(message, (command, args) => {
      signal.throwIfAborted();
      return runCommand(command, args, {
        allowFailure: true,
        env: harborChildEnvironment(executionEnvironment()),
        timeoutMs: 60_000,
        signal,
      });
    });
    signal.throwIfAborted();
    return {
      infrastructure: buildLog ? `${boundedTail(message)}\n\n${buildLog}` : boundedTail(message),
    };
  }
}

async function storeHarborResult(
  store: ArtifactStore,
  prefix: string,
  result: HarborJobResult,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const output = verifierOutput(result);
  await store.put(
    `${prefix}.json`,
    Buffer.from(`${JSON.stringify({ job: result.job, trial: result.trial }, null, 2)}\n`),
    "application/json",
  );
  signal.throwIfAborted();
  if (output) await store.put(`${prefix}-verifier.log`, Buffer.from(output), "text/plain");
  signal.throwIfAborted();
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
