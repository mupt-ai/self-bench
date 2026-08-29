#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../hash.js";
import { runCommand } from "../../process.js";
import { assertRepairPaths, patchPaths, repairPrompt } from "../../repair.js";
import { prepareRepairTask } from "./prepare-repair.js";

const [archivePath, reviewPath, outputArchive, outputReport] = process.argv.slice(2);
if (!archivePath || !reviewPath || !outputArchive || !outputReport) {
  throw new Error("usage: sandbox-repair TASK.tar.gz REVIEW.json OUTPUT.tar.gz OUTPUT-REPORT.json");
}

const { extractedDirectory, taskDirectory, repositoryDirectory } =
  await prepareRepairTask(archivePath);

const [instruction, originalPatch, review] = await Promise.all([
  readFile(join(taskDirectory, "instruction.md"), "utf8"),
  readFile(join(taskDirectory, "tests/test.patch"), "utf8"),
  readFile(reviewPath, "utf8"),
]);
const manifestPath = join(taskDirectory, ".selfbench-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
const taskId = typeof manifest.taskId === "string" ? manifest.taskId : "unknown-task";
const allowedPaths = patchPaths(originalPatch);

const piAuth = process.env.SELFBENCH_PI_AUTH_JSON;
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey && !piAuth) {
  fail("OPENAI_API_KEY or SELFBENCH_PI_AUTH_JSON is required");
}
const piHome = join(homedir(), ".pi/agent");
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
const promptPath = join(tmpdir(), `selfbench-repair-${taskId}.md`);
await writeFile(
  promptPath,
  repairPrompt({
    taskId,
    authenticRequest: instruction,
    couplingReport: review,
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
    apiKey ? "openai" : "openai-codex",
    "--model",
    process.env.SELFBENCH_REPAIR_MODEL ?? "gpt-5.6-sol",
    "--thinking",
    "high",
    "--tools",
    "read,bash,edit,write,grep,find,ls",
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
  throw new Error(`Pi repair exited ${pi.exitCode}: ${pi.stderr.slice(-2_000)}`);
}

const [tracked, untracked] = await Promise.all([
  runCommand("git", ["-C", repositoryDirectory, "diff", "--name-only", "HEAD"]),
  runCommand("git", ["-C", repositoryDirectory, "ls-files", "--others", "--exclude-standard"]),
]);
const changedPaths = [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")]
  .filter(Boolean)
  .sort();
assertRepairPaths(originalPatch, changedPaths);
const repaired = await runCommand("git", ["-C", repositoryDirectory, "diff", "--binary", "HEAD"]);
if (!repaired.stdout.startsWith("diff --git ")) {
  throw new Error(
    `repair produced no held-out test patch; status=${JSON.stringify(changedPaths)}; Pi tail=${pi.stdout.slice(-4_000)}`,
  );
}
if (repaired.stdout === originalPatch) {
  throw new Error("repair left the held-out test patch unchanged");
}

await writeFile(join(taskDirectory, "tests/test.patch"), repaired.stdout);
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      ...manifest,
      testPatchSha256: sha256(repaired.stdout),
      repair: {
        model: process.env.SELFBENCH_REPAIR_MODEL ?? "gpt-5.6-sol",
        originalTestPatchSha256: sha256(originalPatch),
      },
    },
    null,
    2,
  )}\n`,
);
await runCommand("tar", ["-czf", outputArchive, "-C", extractedDirectory, "."]);
await writeFile(
  outputReport,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      taskId,
      model: process.env.SELFBENCH_REPAIR_MODEL ?? "gpt-5.6-sol",
      changedPaths,
      originalTestPatchSha256: sha256(originalPatch),
      repairedTestPatchSha256: sha256(repaired.stdout),
      piOutputTail: pi.stdout.slice(-4_000),
    },
    null,
    2,
  )}\n`,
);

function fail(message: string): never {
  throw new Error(message);
}
