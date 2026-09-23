#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { patchApplyCheck } from "../../generation/checks/patch.js";
import { type StaticCheckError, staticCheckSubmission } from "../../generation/checks/static.js";

// usage: sandbox-check DEFINITION.json TEST.patch GOLD.patch OUTPUT_DIR
//        [--repository DIR --base REF]
// Prints {"ok": boolean, "errors": [{"gate", "message"}], "renderedDirectory"?} and exits 0 when the
// check itself ran; a non-zero exit means the program could not run, not that the task failed.
// With --repository, both patches are proven with git apply --check against a clean worktree of
// REF (test, gold, and gold on top of test), so a corrupt or conflicting patch never costs a build.
const options: Record<string, string> = {};
const positional: string[] = [];
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index] as string;
  if (value === "--repository" || value === "--base") {
    options[value.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  } else {
    positional.push(value);
  }
}
const [definitionPath, testPath, goldPath, outputDirectory] = positional;
if (positional.length !== 4 || !definitionPath || !testPath || !goldPath || !outputDirectory) {
  throw new Error(
    "usage: sandbox-check DEFINITION.json TEST.patch GOLD.patch OUTPUT_DIR [--repository DIR --base REF]",
  );
}
const [definitionJson, testPatch, goldPatch] = await Promise.all([
  readFile(definitionPath, "utf8"),
  readFile(testPath, "utf8"),
  readFile(goldPath, "utf8"),
]);
const result = staticCheckSubmission({ definitionJson, testPatch, goldPatch });
const errors: StaticCheckError[] = [...result.errors];
const patchesWellFormed = !errors.some((error) => error.gate === "patches");
if (options.repository && patchesWellFormed) {
  errors.push(
    ...(await patchApplyCheck({
      repository: options.repository,
      base: options.base || "HEAD",
      testPatch,
      goldPatch,
    })),
  );
}
let renderedDirectory: string | undefined;
if (result.rendered) {
  renderedDirectory = join(outputDirectory, "rendered");
  await rm(renderedDirectory, { recursive: true, force: true });
  for (const [name, contents] of Object.entries(result.rendered)) {
    const path = join(renderedDirectory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode: name.endsWith(".sh") ? 0o755 : 0o644 });
  }
}
process.stdout.write(
  `${JSON.stringify({ ok: errors.length === 0, errors, ...(renderedDirectory ? { renderedDirectory } : {}) })}\n`,
);
