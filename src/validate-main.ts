#!/usr/bin/env node

import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { harborChildEnvironment } from "./harbor-environment.js";
import { harborInfrastructureError, readHarborJobResult } from "./harbor-results.js";
import { parallelMap } from "./parallel.js";
import { runCommand } from "./process.js";

const parsed = parseArgs({
  options: {
    tasks: { type: "string" },
    jobs: { type: "string" },
    environment: { type: "string", default: "modal" },
    concurrency: { type: "string", default: "10" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (parsed.values.help) {
  console.log(`Run Harbor nop and oracle gates for expanded SelfBench tasks.

Usage:
  self-bench-validate --tasks DIRECTORY --jobs DIRECTORY [options]

Options:
  --environment NAME  Harbor environment (default: modal)
  --concurrency N     Concurrent tasks (default: 10)
  -h, --help          Show this help`);
  process.exit(0);
}

const tasksDirectory = resolve(parsed.values.tasks ?? fail("--tasks is required"));
const jobsDirectory = resolve(parsed.values.jobs ?? fail("--jobs is required"));
const environment = parsed.values.environment ?? "modal";
if (environment !== "modal" && environment !== "docker") {
  throw new Error("--environment must be modal or docker");
}
const concurrency = positiveInteger(parsed.values.concurrency, "--concurrency");
const directories = (
  await Promise.all(
    (
      await readdir(tasksDirectory)
    ).map(async (name) => {
      const directory = join(tasksDirectory, name);
      return await access(join(directory, "task.toml")).then(
        () => directory,
        () => undefined,
      );
    }),
  )
).filter((directory): directory is string => directory !== undefined);
await mkdir(jobsDirectory, { recursive: true });

const tasks = await parallelMap(directories.sort(), concurrency, async (taskDirectory) => {
  const taskId = basename(taskDirectory);
  console.error(`validating ${taskId}`);
  try {
    const nop = await runGate(taskDirectory, taskId, "nop", environment, jobsDirectory);
    const oracle = await runGate(taskDirectory, taskId, "oracle", environment, jobsDirectory);
    const accepted = nop.passed && oracle.passed;
    console.error(`${taskId}: ${accepted ? "accepted" : "rejected"}`);
    return { taskId, status: "validated" as const, accepted, nop, oracle };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${taskId}: error: ${message}`);
    return { taskId, status: "error" as const, accepted: false, error: message };
  }
});
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceTasks: tasksDirectory,
  environment,
  summary: {
    total: tasks.length,
    accepted: tasks.filter((task) => task.accepted).length,
    rejected: tasks.filter((task) => task.status === "validated" && !task.accepted).length,
    errors: tasks.filter((task) => task.status === "error").length,
  },
  tasks,
};
await writeFile(
  join(jobsDirectory, "validation-summary.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report.summary, null, 2));

async function runGate(
  taskDirectory: string,
  taskId: string,
  agent: "nop" | "oracle",
  environment: "docker" | "modal",
  jobsDirectory: string,
): Promise<{ readonly passed: boolean; readonly rewards: Readonly<Record<string, number>> }> {
  const jobName = `${taskId}-${agent}-${crypto.randomUUID().slice(0, 8)}`;
  const process = await runCommand(
    "harbor",
    [
      "run",
      "--path",
      taskDirectory,
      "--agent",
      agent,
      "--env",
      environment,
      "--job-name",
      jobName,
      "--jobs-dir",
      jobsDirectory,
      "--n-concurrent",
      "1",
      "--max-retries",
      "1",
      "--delete",
      "--yes",
      "--quiet",
    ],
    {
      allowFailure: true,
      env: harborChildEnvironment(),
      timeoutMs: 4 * 60 * 60 * 1000,
    },
  );
  if (process.exitCode !== 0) {
    throw new Error(`Harbor ${agent} exited ${process.exitCode}: ${process.stderr.slice(-1_000)}`);
  }
  const result = await readHarborJobResult(jobsDirectory, jobName);
  const infrastructure = harborInfrastructureError(result.trial);
  if (infrastructure) {
    throw new Error(`Harbor ${agent} infrastructure failure: ${infrastructure}`);
  }
  const rewards = rewardValues(result.trial);
  const passed =
    agent === "nop"
      ? rewards.fail_to_pass === 0 &&
        (rewards.pass_to_pass ?? 0) >= 1 &&
        (rewards.setup_completed ?? 0) >= 1
      : (rewards.patch_applied ?? 0) >= 1 &&
        (rewards.fail_to_pass ?? 0) >= 1 &&
        (rewards.pass_to_pass ?? 0) >= 1 &&
        (rewards.deterministic ?? 0) >= 1 &&
        (rewards.setup_completed ?? 0) >= 1;
  return { passed, rewards };
}

function rewardValues(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value) || !isRecord(value.verifier_result)) {
    return {};
  }
  const raw = value.verifier_result.rewards;
  return isRecord(raw)
    ? Object.fromEntries(
        Object.entries(raw).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      )
    : {};
}

function positiveInteger(value: string | undefined, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}
