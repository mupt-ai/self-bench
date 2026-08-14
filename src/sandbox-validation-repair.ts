#!/usr/bin/env node

import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { taskDefinitionSchema } from "./contracts.js";
import { runCommand } from "./process.js";
import {
  assertValidationRepair,
  validationRepairPaths,
  validationRepairPrompt,
} from "./validation-repair.js";

const [archivePath, definitionPath, diagnosticsPath, outputDefinition, outputPatch, outputReport] =
  process.argv.slice(2);
if (
  !archivePath ||
  !definitionPath ||
  !diagnosticsPath ||
  !outputDefinition ||
  !outputPatch ||
  !outputReport
) {
  throw new Error(
    "usage: sandbox-validation-repair TASK.tar.gz DEFINITION.json DIAGNOSTICS.txt OUTPUT-DEFINITION.json OUTPUT-PATCH OUTPUT-REPORT.json",
  );
}

const extractedDirectory = "/work/task";
const repositoryDirectory = "/work/repo";
await Promise.all([mkdir(extractedDirectory, { recursive: true }), mkdir(repositoryDirectory)]);
await runCommand("tar", ["-xzf", archivePath, "-C", extractedDirectory]);
const taskDirectory = await access(join(extractedDirectory, "instruction.md")).then(
  () => extractedDirectory,
  () => join(extractedDirectory, "harbor-task"),
);
const [instruction, originalPatch, diagnostics, originalDefinitionBytes] = await Promise.all([
  readFile(join(taskDirectory, "instruction.md"), "utf8"),
  readFile(join(taskDirectory, "tests/test.patch"), "utf8"),
  readFile(diagnosticsPath, "utf8"),
  readFile(definitionPath, "utf8"),
]);
const originalDefinition = taskDefinitionSchema.parse(JSON.parse(originalDefinitionBytes));
const allowedPaths = validationRepairPaths(originalPatch);

await runCommand("tar", [
  "-xzf",
  join(taskDirectory, "tests/repo.tar.gz"),
  "-C",
  repositoryDirectory,
]);
await runCommand("git", ["-C", repositoryDirectory, "init", "-q"]);
await runCommand("git", ["-C", repositoryDirectory, "config", "user.name", "SelfBench"]);
await runCommand("git", ["-C", repositoryDirectory, "config", "user.email", "selfbench@local"]);
await runCommand("git", ["-C", repositoryDirectory, "add", "-A"]);
await runCommand("git", ["-C", repositoryDirectory, "commit", "-qm", "base"]);
await runCommand("git", [
  "-C",
  repositoryDirectory,
  "apply",
  join(taskDirectory, "tests/test.patch"),
]);
await runCommand("git", ["-C", repositoryDirectory, "add", "-N", "--all"]);
await Promise.all([
  writeFile("/work/definition.json", `${JSON.stringify(originalDefinition, null, 2)}\n`),
  writeFile("/work/gold.patch", await readFile(join(taskDirectory, "solution/gold.patch"))),
  writeFile("/work/test.sh", await readFile(join(taskDirectory, "tests/test.sh"))),
]);

const piHome = join(homedir(), ".pi/agent");
const piAuth = process.env.SELFBENCH_PI_AUTH_JSON;
if (!process.env.OPENAI_API_KEY && !piAuth) {
  fail("OPENAI_API_KEY or SELFBENCH_PI_AUTH_JSON is required");
}
await mkdir(piHome, { recursive: true });
await Promise.all([
  ...(piAuth
    ? [
        writeFile(join(piHome, "auth.json"), piAuth).then(() =>
          chmod(join(piHome, "auth.json"), 0o600),
        ),
      ]
    : []),
  writeFile(join(piHome, "settings.json"), `${JSON.stringify({ transport: "auto" })}\n`),
]);
const promptPath = join(tmpdir(), `selfbench-validation-repair-${originalDefinition.taskId}.md`);
await writeFile(
  promptPath,
  validationRepairPrompt({
    definition: originalDefinition,
    authenticRequest: instruction,
    diagnostics,
    allowedPaths,
  }),
);

const pi = await runCommand(
  "pi",
  [
    "--print",
    "--mode",
    "json",
    "--no-session",
    "--no-approve",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-extensions",
    "--provider",
    process.env.OPENAI_API_KEY ? "openai" : "openai-codex",
    "--model",
    process.env.SELFBENCH_REPAIR_MODEL ?? "gpt-5.6-sol",
    "--thinking",
    "high",
    "--tools",
    "read,bash,grep,find,ls",
    `@${promptPath}`,
  ],
  {
    allowFailure: true,
    timeoutMs: 90 * 60 * 1000,
    cwd: repositoryDirectory,
    env: process.env,
    onOutput: (stream, chunk) => {
      (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
    },
  },
);
if (pi.exitCode !== 0) {
  throw new Error(`Pi validation repair exited ${pi.exitCode}: ${pi.stderr.slice(-2_000)}`);
}

const repairedDefinition = taskDefinitionSchema.parse(
  JSON.parse(await readFile("/work/definition.json", "utf8")),
);
const [tracked, untracked] = await Promise.all([
  runCommand("git", ["-C", repositoryDirectory, "diff", "--name-only", "HEAD"]),
  runCommand("git", ["-C", repositoryDirectory, "ls-files", "--others", "--exclude-standard"]),
]);
const changedPaths = [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")]
  .filter(Boolean)
  .sort();
assertValidationRepair(originalDefinition, repairedDefinition, originalPatch, changedPaths);
const repaired = await runCommand("git", ["-C", repositoryDirectory, "diff", "--binary", "HEAD"]);
const repairedPatch = repaired.stdout.startsWith("diff --git ") ? repaired.stdout : originalPatch;
if (
  repairedPatch === originalPatch &&
  JSON.stringify(repairedDefinition) === JSON.stringify(originalDefinition)
) {
  throw new Error("validation repair left the task unchanged");
}

await Promise.all([
  writeFile(outputDefinition, `${JSON.stringify(repairedDefinition, null, 2)}\n`),
  writeFile(outputPatch, repairedPatch),
  writeFile(
    outputReport,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        taskId: originalDefinition.taskId,
        model: process.env.SELFBENCH_REPAIR_MODEL ?? "gpt-5.6-sol",
        changedPaths,
        definitionChanged:
          JSON.stringify(repairedDefinition) !== JSON.stringify(originalDefinition),
        testsChanged: repairedPatch !== originalPatch,
        piOutputTail: pi.stdout.slice(-4_000),
      },
      null,
      2,
    )}\n`,
  ),
]);

function fail(message: string): never {
  throw new Error(message);
}
