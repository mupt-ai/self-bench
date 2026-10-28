#!/usr/bin/env node

import { difficultySchema } from "../../contracts/index.js";
import { patchApplyCheck } from "../../generation/task/patch.js";
import { checkSubmission, readSubmission } from "../../generation/task/submission.js";

// usage: sandbox-check SUBMISSION_DIR DIFFICULTY REPOSITORY BASE
// Prints {"ok": boolean, "errors": string[]} and exits 0 when the check itself ran; a non-zero
// exit means the program could not run, not that the task failed. Both patches are proven with
// git apply --check against a clean worktree of BASE in REPOSITORY (test, gold, and gold on top
// of test), so a corrupt or conflicting patch never costs a build.
const [directory, difficulty, repository, base] = process.argv.slice(2);
if (!directory || !difficulty || !repository || !base) {
  throw new Error("usage: sandbox-check SUBMISSION_DIR DIFFICULTY REPOSITORY BASE");
}
const submission = await readSubmission(directory);
const check = checkSubmission(submission, difficultySchema.parse(difficulty));
const errors = [...check.errors, ...check.blockers];
if (check.errors.length === 0) {
  errors.push(
    ...(await patchApplyCheck({
      repository,
      base,
      testPatch: submission["test.patch"],
      goldPatch: submission["gold.patch"],
    })),
  );
}
process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, errors })}\n`);
