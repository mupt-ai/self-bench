#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { difficultySchema } from "../../contracts/index.js";
import { patchApplyCheck } from "../../generation/task/patch.js";
import {
  WORKSPACE_DIRECTORY,
  workspaceProblems,
  workspaceRepository,
} from "../../generation/task/scenario-workspace.js";
import { checkSubmission, readSubmission } from "../../generation/task/submission.js";

// usage: sandbox-check SUBMISSION_DIR DIFFICULTY REPOSITORY BASE
//        sandbox-check SUBMISSION_DIR DIFFICULTY --scenario
// Prints {"ok": boolean, "errors": string[]} and exits 0 when the check itself ran; a non-zero
// exit means the program could not run, not that the task failed. Both patches are proven with
// git apply --check against a clean worktree of BASE in REPOSITORY (test, gold, and gold on top
// of test), so a corrupt or conflicting patch never costs a build. A scenario's base is the
// workspace/ its author wrote, committed as a repository of its own.
const [directory, difficulty, repository, base] = process.argv.slice(2);
const scenario = repository === "--scenario";
if (!directory || !difficulty || !repository || (!scenario && !base)) {
  throw new Error("usage: sandbox-check SUBMISSION_DIR DIFFICULTY (REPOSITORY BASE | --scenario)");
}
const submission = await readSubmission(directory);
const check = checkSubmission(
  submission,
  difficultySchema.parse(difficulty),
  scenario ? "scenario" : "pull_request",
);
const workspace = join(directory, WORKSPACE_DIRECTORY);
const fileErrors = [...check.errors, ...(scenario ? await workspaceProblems(workspace) : [])];
const errors = [...fileErrors, ...check.blockers];
if (fileErrors.length === 0) {
  const patches = { testPatch: submission["test.patch"], goldPatch: submission["gold.patch"] };
  if (scenario) {
    const scratch = await mkdtemp(join(tmpdir(), "selfbench-workspace-"));
    try {
      const committed = join(scratch, "workspace");
      const head = await workspaceRepository(workspace, committed);
      errors.push(...(await patchApplyCheck({ repository: committed, base: head, ...patches })));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } else if (base) {
    errors.push(...(await patchApplyCheck({ repository, base, ...patches })));
  }
}
process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, errors })}\n`);
