#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { staticCheckSubmission } from "../../static-check.js";

// usage: sandbox-check DEFINITION.json TEST.patch GOLD.patch OUTPUT_DIR
//        [ORIGINAL-DEFINITION.json ORIGINAL-TEST.patch ORIGINAL-GOLD.patch]
// Prints {"ok": boolean, "errors": [{"gate", "message"}], "renderedDirectory"?} and exits 0 when the
// check itself ran; a non-zero exit means the program could not run, not that the task failed.
const [definitionPath, testPath, goldPath, outputDirectory, ...original] = process.argv.slice(2);
if (!definitionPath || !testPath || !goldPath || !outputDirectory) {
  throw new Error(
    "usage: sandbox-check DEFINITION.json TEST.patch GOLD.patch OUTPUT_DIR [ORIGINAL-DEFINITION ORIGINAL-TEST ORIGINAL-GOLD]",
  );
}
if (original.length !== 0 && original.length !== 3) {
  throw new Error(
    "sandbox-check fix mode requires the original definition, test patch, and gold patch",
  );
}
const [definitionJson, testPatch, goldPatch] = await Promise.all([
  readFile(definitionPath, "utf8"),
  readFile(testPath, "utf8"),
  readFile(goldPath, "utf8"),
]);
const originalFiles =
  original.length === 3
    ? await Promise.all(original.map((path) => readFile(path as string, "utf8")))
    : undefined;
const result = staticCheckSubmission({
  definitionJson,
  testPatch,
  goldPatch,
  ...(originalFiles
    ? {
        original: {
          definitionJson: originalFiles[0] as string,
          testPatch: originalFiles[1] as string,
          goldPatch: originalFiles[2] as string,
        },
      }
    : {}),
});
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
  `${JSON.stringify({ ok: result.ok, errors: result.errors, ...(renderedDirectory ? { renderedDirectory } : {}) })}\n`,
);
