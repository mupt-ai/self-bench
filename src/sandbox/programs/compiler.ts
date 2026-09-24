#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isHarborEnvironment } from "../../contracts/config/providers.js";
import { staticCheckSubmission } from "../../generation/task/static.js";
import { extractRegularArchive } from "../../lib/archive.js";
import { errorMessage } from "../../lib/util.js";
import { compileSubmittedTask, TaskCompilerInfrastructureError } from "../task-compiler.js";

// Trusted compile of one submission (definition.json, test.patch, gold.patch in a tarball):
// schema, policy, paths, patches, audit, candidate identity, then the rendered Harbor task.
// Writes /work/result.json {compileErrors, auditBlockers} and /work/compiled.tar.gz. When the
// compiler itself cannot run (e.g. the clone fails) it writes neither and exits 1, so the attempt
// fails and is retried.
const work = process.env.SELFBENCH_COMPILER_WORK ?? "/work";
const submission = join(work, "submission");
const input = JSON.parse(await readFile(join(work, "input.json"), "utf8"));
const sourceBundle = await readFile(join(work, "source-task.tar.gz"));
const unpackErrors: string[] = [];
await mkdir(submission, { recursive: true });
await extractRegularArchive(join(work, "source-task.tar.gz"), submission).catch((error) =>
  unpackErrors.push(`[bundle] submission bundle could not be unpacked: ${errorMessage(error)}`),
);
const [definitionJson, testPatch, goldPatch] = await Promise.all(
  ["definition.json", "test.patch", "gold.patch"].map((name) =>
    readFile(join(submission, name), "utf8").catch(() => ""),
  ),
);
const harborEnvironment = String(input.harborEnvironment ?? "");
const check = staticCheckSubmission({
  definitionJson: definitionJson ?? "",
  testPatch: testPatch ?? "",
  goldPatch: goldPatch ?? "",
  ...(isHarborEnvironment(harborEnvironment) ? { harborEnvironment } : {}),
});
const compileErrors = check.errors
  .filter((error) => error.gate !== "audit")
  .map((error) => `[${error.gate}] ${error.message}`);
compileErrors.unshift(...unpackErrors);
const auditBlockers = check.errors
  .filter((error) => error.gate === "audit")
  .map((error) => error.message);
let bundle: Uint8Array = Buffer.alloc(0);
if (compileErrors.length === 0) {
  const definition = JSON.parse(definitionJson ?? "{}");
  const { candidate } = input;
  const tiers = { easy: 1, medium: 2, hard: 3 } as Record<string, number>;
  for (const field of ["sourcePr", "sourceUrl"] as const) {
    if (definition[field] !== candidate[field]) {
      compileErrors.push(
        `definition ${field} is ${JSON.stringify(definition[field])} but the candidate requires ${JSON.stringify(candidate[field])}`,
      );
    }
  }
  if (String(definition.baseCommit).toLowerCase() !== candidate.baseCommit.toLowerCase()) {
    compileErrors.push(
      `definition baseCommit must be the candidate's base commit ${candidate.baseCommit}`,
    );
  }
  if ((tiers[definition.difficulty] ?? 0) > (tiers[candidate.difficulty] ?? 0)) {
    compileErrors.push(
      `definition difficulty ${definition.difficulty} is above the assigned ${candidate.difficulty}`,
    );
  }
  if (compileErrors.length === 0) {
    try {
      bundle = await compileSubmittedTask({
        taskId: definition.taskId,
        repositoryUrl: input.repositoryUrl,
        definitionBytes: Buffer.from(`${JSON.stringify(definition, null, 2)}\n`),
        sourceBundle,
        ...(process.env.GH_TOKEN ? { token: process.env.GH_TOKEN } : {}),
      });
    } catch (error) {
      const message = process.env.GH_TOKEN
        ? errorMessage(error).replaceAll(process.env.GH_TOKEN, "[redacted]")
        : errorMessage(error);
      if (error instanceof TaskCompilerInfrastructureError) {
        process.stderr.write(`compiler could not run: ${message}\n`);
        process.exit(1);
      }
      compileErrors.push(message);
    }
  }
}
await writeFile(join(work, "compiled.tar.gz"), bundle);
await writeFile(join(work, "result.json"), JSON.stringify({ compileErrors, auditBlockers }));
