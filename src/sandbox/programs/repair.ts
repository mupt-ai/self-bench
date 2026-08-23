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

const codexAuth = process.env.SELFBENCH_CODEX_AUTH_JSON;
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey && !codexAuth) {
  fail("OPENAI_API_KEY or SELFBENCH_CODEX_AUTH_JSON is required");
}
const codexHome = join(homedir(), ".codex");
const authPath = join(codexHome, "auth.json");
await mkdir(codexHome, { recursive: true });
await writeFile(authPath, codexAuth ?? `${JSON.stringify({ OPENAI_API_KEY: apiKey })}\n`);
await chmod(authPath, 0o600);
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

const codex = await runCommand(
  "codex",
  [
    "exec",
    "--model",
    process.env.SELFBENCH_REPAIR_MODEL ?? "gpt-5.6-sol",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    "-C",
    repositoryDirectory,
    "-",
  ],
  {
    allowFailure: true,
    timeoutMs: 90 * 60 * 1000,
    env: process.env,
    input: await readFile(promptPath, "utf8"),
    onOutput: (stream, chunk) => {
      (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
    },
  },
);
if (codex.exitCode !== 0) {
  throw new Error(`Codex repair exited ${codex.exitCode}: ${codex.stderr.slice(-2_000)}`);
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
    `repair produced no held-out test patch; status=${JSON.stringify(changedPaths)}; Codex tail=${codex.stdout.slice(-4_000)}`,
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
      codexOutputTail: codex.stdout.slice(-4_000),
    },
    null,
    2,
  )}\n`,
);

function fail(message: string): never {
  throw new Error(message);
}
