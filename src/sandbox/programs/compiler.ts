#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { staticCheckSubmission } from "../../generation/checks/static.js";
import { extractRegularArchive } from "../../lib/archive.js";
import { errorMessage } from "../../lib/util.js";
import { compileSubmittedTask, TaskCompilerInfrastructureError } from "../task-compiler.js";

// Trusted compile of one submission (definition.json, test.patch, gold.patch in a tarball):
// schema, policy, paths, patches, audit, candidate identity, then the rendered Harbor task.
// Writes /work/result.json {compileErrors, auditBlockers, infrastructure?} and /work/compiled.tar.gz.
const input = JSON.parse(await readFile("/work/input.json", "utf8"));
const sourceBundle = await readFile("/work/source-task.tar.gz");
await extractRegularArchive("/work/source-task.tar.gz", "/work/submission");
const [definitionJson, testPatch, goldPatch] = await Promise.all(
  ["definition.json", "test.patch", "gold.patch"].map((name) =>
    readFile(join("/work/submission", name), "utf8").catch(() => ""),
  ),
);
const check = staticCheckSubmission({
  definitionJson: definitionJson ?? "",
  testPatch: testPatch ?? "",
  goldPatch: goldPatch ?? "",
});
const compileErrors = check.errors
  .filter((error) => error.gate !== "audit")
  .map((error) => `[${error.gate}] ${error.message}`);
const auditBlockers = check.errors
  .filter((error) => error.gate === "audit")
  .map((error) => error.message);
let infrastructure: string | undefined;
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
      if (error instanceof TaskCompilerInfrastructureError) infrastructure = message;
      else compileErrors.push(message);
    }
  }
}
await writeFile("/work/compiled.tar.gz", bundle);
await writeFile(
  "/work/result.json",
  JSON.stringify({ compileErrors, auditBlockers, ...(infrastructure ? { infrastructure } : {}) }),
);
