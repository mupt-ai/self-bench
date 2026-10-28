#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractRegularArchive } from "../../lib/archive.js";
import { errorMessage } from "../../lib/util.js";
import { writeCompiled } from "../gate-bundle.js";
import { compileSubmission, type SubmissionCompileResult } from "../task-compiler.js";

// Trusted compile of one submission (the author's files in a tarball): the static check, base
// image pins, then the rendered Harbor task. Writes /work/result.json {compileErrors,
// auditBlockers} and /work/compiled.tar.gz. When the compiler itself cannot run (the clone fails
// or a registry is down) it writes neither and exits 1, so the attempt fails and is retried.
const work = process.env.SELFBENCH_COMPILER_WORK ?? "/work";
const submission = join(work, "submission");
const input = JSON.parse(await readFile(join(work, "input.json"), "utf8"));
await mkdir(submission, { recursive: true });
const result: SubmissionCompileResult = await extractRegularArchive(
  join(work, "source-task.tar.gz"),
  submission,
).then(
  () =>
    compileSubmission({
      repositoryUrl: input.repositoryUrl,
      directory: submission,
      taskId: input.taskId,
      candidate: input.candidate,
      ...(process.env.GH_TOKEN ? { token: process.env.GH_TOKEN } : {}),
    }),
  (error) => ({
    compileErrors: [`the submission bundle could not be unpacked: ${errorMessage(error)}`],
    auditBlockers: [],
  }),
);
await writeCompiled(work, result.bundle);
await writeFile(
  join(work, "result.json"),
  JSON.stringify({ compileErrors: result.compileErrors, auditBlockers: result.auditBlockers }),
);
