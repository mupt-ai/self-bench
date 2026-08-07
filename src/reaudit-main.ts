#!/usr/bin/env node

import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  COUPLING_REVIEW_MODEL,
  couplingReviewInput,
  couplingReviewSchema,
} from "./codex-review.js";
import { loadConfig } from "./config.js";
import {
  buildCouplingEvidence,
  discoverContractArtifacts,
  resolveCouplingReview,
  scanBaseContractArtifacts,
} from "./coupling.js";
import { parallelMap } from "./parallel.js";
import { runCommand } from "./process.js";
import { createSandboxExecutor, type SandboxExecutor } from "./sandbox.js";
import { loadPiSubscriptionAuth } from "./subscription-auth.js";

const parsed = parseArgs({
  options: {
    tasks: { type: "string" },
    task: { type: "string" },
    output: { type: "string" },
    concurrency: { type: "string", default: "10" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (parsed.values.help) {
  console.log(`Re-audit expanded Harbor tasks for test-to-gold coupling.

Usage:
  selfbench-reaudit --tasks DIRECTORY --output REPORT.json [options]

Options:
  --concurrency N  Concurrent Sol reviews (default: 10)
  --task ID        Review only one task ID
  -h, --help       Show this help`);
  process.exit(0);
}

const tasksDirectory = resolve(parsed.values.tasks ?? fail("--tasks is required"));
const outputPath = resolve(parsed.values.output ?? fail("--output is required"));
const concurrency = positiveInteger(parsed.values.concurrency, "--concurrency");
const config = loadConfig();
const sandbox = createSandboxExecutor(config.execution);
const [taskIds, piAuth, reviewer] = await Promise.all([
  readdir(tasksDirectory),
  loadPiSubscriptionAuth(),
  readFile(join(assetRoot(), "dist/sandbox-review.bundle.js")),
]);
const directories = (
  await Promise.all(
    taskIds.map(async (taskId) => {
      const taskDirectory = join(tasksDirectory, taskId);
      return await access(join(taskDirectory, "instruction.md")).then(
        () => taskDirectory,
        () => undefined,
      );
    }),
  )
)
  .filter((directory): directory is string => directory !== undefined)
  .filter(
    (directory) => parsed.values.task === undefined || basename(directory) === parsed.values.task,
  )
  .sort();
if (directories.length === 0) {
  throw new Error(parsed.values.task ? `task not found: ${parsed.values.task}` : "no tasks found");
}

const tasks = await parallelMap(directories, concurrency, async (taskDirectory) => {
  const taskId = basename(taskDirectory);
  console.error(`reviewing ${taskId}`);
  try {
    const report = await auditTask(taskDirectory, taskId, piAuth, reviewer, sandbox);
    console.error(`${taskId}: ${report.resolution.verdict}`);
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${taskId}: error: ${message}`);
    return { taskId, status: "error" as const, error: message };
  }
});
sandbox.close();
const report = {
  schemaVersion: 1,
  reviewer: COUPLING_REVIEW_MODEL,
  generatedAt: new Date().toISOString(),
  sourceTasks: tasksDirectory,
  provisional: true,
  tasks,
  summary: {
    total: tasks.length,
    clean: tasks.filter((task) => task.status === "reviewed" && task.resolution.verdict === "clean")
      .length,
    coupled: tasks.filter(
      (task) => task.status === "reviewed" && task.resolution.verdict === "coupled",
    ).length,
    errors: tasks.filter((task) => task.status === "error").length,
  },
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, ...report.summary }, null, 2));

async function auditTask(
  taskDirectory: string,
  taskId: string,
  piAuth: string,
  reviewer: Uint8Array,
  sandbox: SandboxExecutor,
) {
  const scratch = await mkdtemp(join(tmpdir(), "selfbench-reaudit-"));
  try {
    const baseDirectory = join(scratch, "base");
    const baseArchivePath = join(taskDirectory, "environment/repo.tar.gz");
    await mkdir(baseDirectory);
    await runCommand("tar", ["-xzf", baseArchivePath, "-C", baseDirectory]);
    const [prompt, testPatch, goldPatch] = await Promise.all([
      readFile(join(taskDirectory, "instruction.md"), "utf8"),
      readFile(join(taskDirectory, "tests/test.patch"), "utf8"),
      readFile(join(taskDirectory, "solution/gold.patch"), "utf8"),
    ]);
    const baseArtifacts = await scanBaseContractArtifacts(
      baseDirectory,
      scratch,
      discoverContractArtifacts(testPatch),
    );
    const couplingEvidence = buildCouplingEvidence({
      prompt,
      testPatch,
      goldPatch,
      baseArtifacts,
    });
    const result = await sandbox.run({
      runId: "selfbench-reaudit-v2",
      stage: taskId,
      timeoutMs: 15 * 60 * 1000,
      files: [
        { path: "/work/sandbox-review.js", contents: reviewer },
        {
          path: "/work/review-input.md",
          contents: couplingReviewInput(prompt, testPatch, goldPatch, couplingEvidence),
        },
      ],
      outputPaths: ["/work/review.json"],
      secrets: { SELFBENCH_PI_AUTH_JSON: piAuth },
      environment: { SELFBENCH_REVIEW_OUTPUT: "/work/review.json" },
      command: ["node", "/work/sandbox-review.js"],
    });
    const output = result.outputs["/work/review.json"];
    if (result.exitCode !== 0 || !output) {
      throw new Error(
        `sandboxed coupling review failed in ${result.sandboxId}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const review = couplingReviewSchema.parse(JSON.parse(Buffer.from(output).toString("utf8")));
    return {
      taskId,
      status: "reviewed" as const,
      sandboxId: result.sandboxId,
      couplingEvidence,
      review,
      resolution: resolveCouplingReview(couplingEvidence, review),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function assetRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function fail(message: string): never {
  throw new Error(message);
}
