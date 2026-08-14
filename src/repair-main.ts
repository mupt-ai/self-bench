#!/usr/bin/env node

import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { parallelMap } from "./parallel.js";
import { runCommand } from "./process.js";
import { createSandboxExecutor } from "./sandbox.js";
import { loadCodexModelAuth } from "./subscription-auth.js";

const parsed = parseArgs({
  options: {
    tasks: { type: "string" },
    review: { type: "string" },
    output: { type: "string" },
    task: { type: "string" },
    concurrency: { type: "string", default: "9" },
    model: { type: "string", default: "gpt-5.6-sol" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (parsed.values.help) {
  console.log(`Repair coupled tests in expanded Harbor tasks.

Usage:
  self-bench-repair --tasks DIRECTORY --review REPORT.json --output DIRECTORY [options]

Options:
  --concurrency N  Concurrent repair sandboxes (default: 9)
  --model MODEL    Codex subscription model (default: gpt-5.6-sol)
  --task ID        Repair only one coupled task
  -h, --help       Show this help`);
  process.exit(0);
}

const tasksDirectory = resolve(parsed.values.tasks ?? fail("--tasks is required"));
const reviewPath = resolve(parsed.values.review ?? fail("--review is required"));
const outputDirectory = resolve(parsed.values.output ?? fail("--output is required"));
if (outputDirectory === tasksDirectory || outputDirectory.startsWith(`${tasksDirectory}/`)) {
  throw new Error("--output must be outside --tasks");
}
const concurrency = positiveInteger(parsed.values.concurrency, "--concurrency");
const rawReview = JSON.parse(await readFile(reviewPath, "utf8")) as unknown;
const review = reviewReport(rawReview);
const coupled = new Map(
  review.tasks
    .filter((task) => task.resolution.verdict === "coupled")
    .filter((task) => parsed.values.task === undefined || task.taskId === parsed.values.task)
    .map((task) => [task.taskId, task]),
);
if (parsed.values.task !== undefined && coupled.size === 0) {
  throw new Error(`coupled task not found in review: ${parsed.values.task}`);
}
const sourceTasks = (
  await Promise.all(
    (
      await readdir(tasksDirectory)
    ).map(async (taskId) => {
      const directory = join(tasksDirectory, taskId);
      return await access(join(directory, "instruction.md")).then(
        () => directory,
        () => undefined,
      );
    }),
  )
).filter((directory): directory is string => directory !== undefined);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
for (const source of sourceTasks) {
  if (parsed.values.task === undefined && !coupled.has(basename(source))) {
    await cp(source, join(outputDirectory, basename(source)), { recursive: true });
  }
}

const config = loadConfig();
const sandbox = createSandboxExecutor(config.execution);
const [modelAuth, repairer] = await Promise.all([
  loadCodexModelAuth(),
  readFile(join(assetRoot(), "dist/sandbox-repair.bundle.js")),
]);
const results = await parallelMap([...coupled.values()], concurrency, async (taskReview) => {
  const taskId = taskReview.taskId;
  const source = join(tasksDirectory, taskId);
  console.error(`repairing ${taskId}`);
  const scratch = await mkdtemp(join(tmpdir(), `selfbench-repair-${taskId}-`));
  try {
    const archive = join(scratch, "task.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", source, "."]);
    const result = await sandbox.run({
      runId: "selfbench-repair-v1",
      stage: taskId,
      timeoutMs: 2 * 60 * 60 * 1000,
      cpu: 4,
      memoryMiB: 8192,
      files: [
        { path: "/work/task.tar.gz", contents: await readFile(archive) },
        { path: "/work/review.json", contents: `${JSON.stringify(taskReview, null, 2)}\n` },
        { path: "/work/sandbox-repair.js", contents: repairer },
      ],
      outputPaths: ["/work/repaired-task.tar.gz", "/work/repair-report.json"],
      secrets: {
        ...(modelAuth.apiKey ? { OPENAI_API_KEY: modelAuth.apiKey } : {}),
        ...(modelAuth.authJson ? { SELFBENCH_CODEX_AUTH_JSON: modelAuth.authJson } : {}),
      },
      environment: { SELFBENCH_REPAIR_MODEL: parsed.values.model ?? "gpt-5.6-sol" },
      command: [
        "node",
        "/work/sandbox-repair.js",
        "/work/task.tar.gz",
        "/work/review.json",
        "/work/repaired-task.tar.gz",
        "/work/repair-report.json",
      ],
    });
    const repaired = result.outputs["/work/repaired-task.tar.gz"];
    const report = result.outputs["/work/repair-report.json"];
    if (result.exitCode !== 0 || !repaired || !report) {
      throw new Error(
        `repair sandbox ${result.sandboxId} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const destination = join(outputDirectory, taskId);
    await mkdir(destination);
    const repairedArchive = join(scratch, "repaired-task.tar.gz");
    await writeFile(repairedArchive, repaired);
    await runCommand("tar", ["-xzf", repairedArchive, "-C", destination]);
    const parsedReport = JSON.parse(Buffer.from(report).toString("utf8")) as Record<
      string,
      unknown
    >;
    console.error(`${taskId}: repaired in ${result.sandboxId}`);
    return { taskId, status: "repaired" as const, sandboxId: result.sandboxId, ...parsedReport };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${taskId}: error: ${message}`);
    return { taskId, status: "error" as const, error: message };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
sandbox.close();
const reportOutput = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceTasks: tasksDirectory,
  sourceReview: reviewPath,
  outputTasks: outputDirectory,
  model: parsed.values.model,
  copiedClean: parsed.values.task === undefined ? sourceTasks.length - coupled.size : 0,
  repaired: results.filter((result) => result.status === "repaired").length,
  errors: results.filter((result) => result.status === "error").length,
  tasks: results,
};
await writeFile(
  join(outputDirectory, "repair-report.json"),
  `${JSON.stringify(reportOutput, null, 2)}\n`,
);
console.log(JSON.stringify(reportOutput, null, 2));

interface ReviewTask {
  readonly taskId: string;
  readonly resolution: { readonly verdict: "clean" | "coupled" };
  readonly [key: string]: unknown;
}

function reviewReport(value: unknown): { readonly tasks: readonly ReviewTask[] } {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    throw new Error("invalid coupling review report");
  }
  const tasks = value.tasks.filter(
    (task): task is ReviewTask =>
      isRecord(task) &&
      typeof task.taskId === "string" &&
      isRecord(task.resolution) &&
      (task.resolution.verdict === "clean" || task.resolution.verdict === "coupled"),
  );
  if (tasks.length !== value.tasks.length) {
    throw new Error("coupling review report contains invalid task entries");
  }
  return { tasks };
}

function assetRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
